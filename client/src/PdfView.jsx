import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { pdfjsLib, DOC_OPTS, loadViewer, expandCite } from './pdfjs.js';
import { COLORS } from './api.js';

// Low-level pdf.js viewer: highlights overlay, selection capture, citation hover / internal-link interception.
const PdfView = forwardRef(function PdfView(props, ref) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const st = useRef({});
  const cbs = useRef(props);
  cbs.current = props;

  // ---------- init ----------
  useEffect(() => {
    let cancelled = false;
    let task;
    (async () => {
      const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = await loadViewer();
      if (cancelled) return;
      const eventBus = new EventBus();
      const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer' });
      const findController = new PDFFindController({ eventBus, linkService });
      const viewer = new PDFViewer({
        container: containerRef.current, viewer: viewerRef.current, eventBus, linkService, findController,
        textLayerMode: 1, annotationMode: pdfjsLib.AnnotationMode.ENABLE,
        annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
      });
      linkService.setViewer(viewer);
      task = pdfjsLib.getDocument({ url: props.url, ...DOC_OPTS });
      let doc;
      try { doc = await task.promise; } catch (e) { cbs.current.onError?.(e); return; }
      if (cancelled) return;
      st.current = { eventBus, linkService, findController, viewer, doc, history: [] };
      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width';
        const p = cbs.current.initialPage;
        if (p > 1 && p <= doc.numPages) viewer.currentPageNumber = p;
      });
      eventBus.on('pagechanging', e => cbs.current.onPageChange?.(e.pageNumber));
      eventBus.on('pagerendered', e => drawPage(e.pageNumber));
      eventBus.on('textlayerrendered', e => drawPage(e.pageNumber));
      eventBus.on('scalechanging', e => cbs.current.onScale?.(e.scale));
      eventBus.on('updatefindmatchescount', e => cbs.current.onFindCount?.(e.matchesCount));
      eventBus.on('updatefindcontrolstate', e => cbs.current.onFindCount?.(e.matchesCount, e.state));
      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
      const outline = await doc.getOutline().catch(() => null);
      cbs.current.onReady?.({ numPages: doc.numPages, outline: outline || [] });
    })();
    return () => {
      cancelled = true;
      const { viewer, doc } = st.current;
      try { viewer?.setDocument(null); } catch { /* ignore */ }
      doc?.destroy();
      task?.destroy();
      st.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url]);

  // Re-apply relative zoom (page-width / page-fit / auto) when the container is resized,
  // e.g. while dragging a column splitter; fixed percentages are left alone
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0, lastW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - lastW) < 2) return;
      lastW = el.clientWidth;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const v = st.current.viewer;
        const mode = v?.currentScaleValue;
        if (v && typeof mode === 'string' && /^(page-width|page-fit|auto)$/.test(mode)) v.currentScaleValue = mode;
      });
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // ---------- highlights ----------
  function pageDiv(n) { return viewerRef.current?.querySelector(`.page[data-page-number="${n}"]`); }
  function drawPage(n) {
    const div = pageDiv(n);
    if (!div) return;
    div.querySelector(':scope > .hl-layer')?.remove();
    const anns = (cbs.current.annotations || []).filter(a => a.rects?.some(r => (r.p ?? a.page) === n));
    if (!anns.length) return;
    const layer = document.createElement('div');
    layer.className = 'hl-layer';
    for (const a of anns) {
      for (const r of a.rects) {
        if ((r.p ?? a.page) !== n) continue;
        const d = document.createElement('div');
        d.className = 'hl' + (a.id === cbs.current.activeId ? ' active' : '');
        d.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;--hl:${COLORS[a.color]?.hex || '#ffd400'}`;
        layer.append(d);
      }
    }
    div.insertBefore(layer, div.querySelector(':scope > .textLayer'));
  }
  function drawAll() {
    viewerRef.current?.querySelectorAll('.page[data-page-number]').forEach(d => drawPage(+d.dataset.pageNumber));
  }
  // Annotations usually load before pdf.js has created its page elements, so retry briefly
  useEffect(() => {
    drawAll();
    const ts = [60, 250, 700, 1500].map(ms => setTimeout(drawAll, ms));
    return () => ts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.annotations, props.activeId]);

  // ---------- geometry helpers ----------
  function pageAt(x, y) {
    for (const d of viewerRef.current?.querySelectorAll('.page[data-page-number]') || []) {
      const r = d.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { div: d, n: +d.dataset.pageNumber, r };
    }
    return null;
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) return null;
    const text = cleanText(sel.toString());
    if (!text) return null;
    const rects = [];
    for (const cr of range.getClientRects()) {
      if (cr.width < 1 || cr.height < 1) continue;
      const pg = pageAt(cr.left + cr.width / 2, cr.top + cr.height / 2);
      if (!pg) continue;
      if (cr.height > pg.r.height * 0.06 || cr.width > pg.r.width * 0.98) continue; // endOfContent artifacts
      rects.push({ p: pg.n, x: (cr.left - pg.r.left) / pg.r.width, y: (cr.top - pg.r.top) / pg.r.height, w: cr.width / pg.r.width, h: cr.height / pg.r.height });
    }
    if (!rects.length) return null;
    return { text, rects: mergeRects(rects), page: rects[0].p, clientRect: range.getBoundingClientRect() };
  }

  function annotationAt(x, y) {
    const pg = pageAt(x, y);
    if (!pg) return null;
    const px = (x - pg.r.left) / pg.r.width, py = (y - pg.r.top) / pg.r.height;
    const anns = cbs.current.annotations || [];
    for (let i = anns.length - 1; i >= 0; i--) {
      const a = anns[i];
      if (a.rects?.some(r => (r.p ?? a.page) === pg.n && px >= r.x && px <= r.x + r.w && py >= r.y - 0.002 && py <= r.y + r.h + 0.002)) return a;
    }
    return null;
  }

  // Characters of the visual text line at (x,y) with their screen boxes
  function lineChars(pg, y) {
    const spans = [...pg.div.querySelectorAll('.textLayer span')].filter(s => {
      if (s.children.length) return false;
      const r = s.getBoundingClientRect();
      return r.height > 0 && y >= r.top - 1 && y <= r.bottom + 1;
    });
    const chars = [];
    const range = document.createRange();
    for (const s of spans) {
      const node = s.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const t = node.textContent;
      for (let i = 0; i < t.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        chars.push({ ch: t[i], l: r.left, r: r.right });
      }
    }
    chars.sort((a, b) => a.l - b.l);
    return chars;
  }

  // Detect a numeric citation group like [12], [3, 7], [29–32] around point
  function citeAtPoint(x, y) {
    const pg = pageAt(x, y);
    if (!pg) return null;
    const chars = lineChars(pg, y);
    if (!chars.length) return null;
    let idx = chars.findIndex(c => x >= c.l - 0.5 && x <= c.r + 0.5);
    if (idx < 0) return null;
    let s = idx, e = idx;
    while (s > 0 && idx - s < 40 && chars[s].ch !== '[' && !(chars[s].ch === ']' && s !== idx)) s--;
    while (e < chars.length - 1 && e - idx < 40 && chars[e].ch !== ']' && !(chars[e].ch === '[' && e !== idx)) e++;
    if (chars[s].ch !== '[' || chars[e].ch !== ']') return null;
    const innerChars = chars.slice(s + 1, e);
    const inner = innerChars.map(c => c.ch).join('');
    if (!/^[\d\s,;–—-]+$/.test(inner)) return null;
    const nums = expandCite(inner);
    if (!nums.length) return null;
    // The comma-separated part under the cursor: "2" in [35, 2, 5]; "29–32" (expanded) in [29–32, 40]
    let part = null, buf = [];
    for (const c of [...innerChars, { ch: ',', l: Infinity, r: Infinity }]) {
      if (c.ch === ',' || c.ch === ';') {
        const txt = buf.map(b => b.ch).join('').trim();
        if (txt && buf.length && x >= buf[0].l - 3 && x <= buf[buf.length - 1].r + 3) part = expandCite(txt);
        buf = [];
      } else buf.push(c);
    }
    return { nums, part: part?.length ? part : null, label: `[${inner.replace(/\s+/g, '')}]`, rect: { left: chars[s].l, right: chars[e].r, top: y - 8, bottom: y + 8 }, page: pg.n };
  }

  async function resolveLinkDest(a) {
    const { doc } = st.current;
    const href = a.getAttribute('href') || '';
    let dest = decodeURIComponent(href.slice(href.indexOf('#') + 1));
    try { const j = JSON.parse(dest); if (Array.isArray(j)) dest = j; } catch { /* named */ }
    if (typeof dest === 'string') {
      const pm = dest.match(/(?:^|&)page=(\d+)/);
      if (pm) return { pageNum: +pm[1], x: null, y: null, dest: null };
      dest = await doc.getDestination(dest).catch(() => null);
    }
    if (!Array.isArray(dest)) return null;
    const [refObj, kind, ...args] = dest;
    let pageIndex;
    try { pageIndex = typeof refObj === 'object' ? await doc.getPageIndex(refObj) : refObj; } catch { return null; }
    let x = null, y = null;
    switch (kind?.name) {
      case 'XYZ': x = args[0]; y = args[1]; break;
      case 'FitH': case 'FitBH': y = args[0]; break;
      case 'FitR': x = args[0]; y = args[3]; break;
      default: break;
    }
    return { pageNum: pageIndex + 1, x, y, dest };
  }

  // ---------- events ----------
  useEffect(() => {
    const el = containerRef.current;
    let hoverTimer = null, lastKey = '';
    const linkCache = new WeakMap();

    const onClickCapture = async e => {
      const a = e.target.closest?.('.annotationLayer a');
      if (!a || !a.closest('section')?.hasAttribute('data-internal-link')) return;
      if (e.ctrlKey || e.metaKey) { pushHistory(); return; } // real jump
      e.preventDefault(); e.stopPropagation();
      const info = await linkInfo(a);
      if (info) cbs.current.onInternalLink?.(info);
    };
    const linkInfo = async a => {
      if (linkCache.has(a)) return linkCache.get(a);
      const r = a.getBoundingClientRect();
      const dest = await resolveLinkDest(a);
      if (!dest) return null;
      const cite = citeAtPoint(r.left + r.width / 2, r.top + r.height / 2);
      const info = { ...dest, cite, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
      linkCache.set(a, info);
      return info;
    };
    const onMove = e => {
      if (e.buttons) return;
      const a = e.target.closest?.('.annotationLayer a');
      const isInternal = a?.closest('section')?.hasAttribute('data-internal-link');
      const inText = !a && e.target.closest?.('.textLayer');
      const key = a ? `a:${a.href}:${a.getBoundingClientRect().left}` : '';
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(async () => {
        if (isInternal) {
          const info = await linkInfo(a);
          if (info) { lastKey = key; cbs.current.onHover?.({ ...info, rect: freshRect(a) }); }
        } else if (inText && cbs.current.numericRefs) {
          const c = citeAtPoint(e.clientX, e.clientY);
          const k = c ? `t:${c.page}:${c.label}:${Math.round(c.rect.left)}` : '';
          if (c && k !== lastKey) { lastKey = k; cbs.current.onHover?.({ cite: c, rect: c.rect, pageNum: null }); }
          else if (!c) { lastKey = ''; cbs.current.onHoverEnd?.(); }
        } else { lastKey = ''; cbs.current.onHoverEnd?.(); }
      }, a ? 180 : 260);
    };
    const freshRect = a => { const r = a.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const onLeave = () => { clearTimeout(hoverTimer); lastKey = ''; cbs.current.onHoverEnd?.(); };
    let downAt = null;
    const onDown = e => { downAt = { x: e.clientX, y: e.clientY }; cbs.current.onPointerDown?.(e); };
    const onUp = e => {
      if (e.button !== 0) return;
      setTimeout(() => {
        const info = selectionInfo();
        if (info) {
          // Anchor floating UI near the release point when the selection spans a tall area
          const cr = info.clientRect;
          if (cr.height > 80 || cr.top < 0 || cr.bottom > window.innerHeight) {
            info.clientRect = { left: e.clientX - 40, right: e.clientX + 40, top: e.clientY - 10, bottom: e.clientY + 10 };
          }
          return cbs.current.onSelect?.(info);
        }
        const moved = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
        if (moved) return;
        const a = annotationAt(e.clientX, e.clientY);
        cbs.current.onAnnotationClick?.(a, { x: e.clientX, y: e.clientY });
      }, 0);
    };
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mouseup', onUp);
    const onScroll = () => cbs.current.onScroll?.();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(hoverTimer);
      el.removeEventListener('click', onClickCapture, true);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mouseup', onUp);
      el.removeEventListener('scroll', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushHistory() {
    const { viewer } = st.current;
    if (!viewer) return;
    st.current.history.push({ top: containerRef.current.scrollTop, left: containerRef.current.scrollLeft, scale: viewer.currentScaleValue });
    cbs.current.onHistory?.(st.current.history.length);
  }

  // ---------- imperative API ----------
  useImperativeHandle(ref, () => ({
    goToPage(n) { pushHistory(); st.current.viewer.currentPageNumber = n; },
    async goToDest(dest, pageNum) {
      pushHistory();
      if (dest) st.current.linkService.goToDestination(dest);
      else if (pageNum) st.current.viewer.currentPageNumber = pageNum;
    },
    goToAnnotation(a) {
      const { viewer } = st.current;
      const r = a.rects?.[0];
      if (!viewer || !r) return;
      const n = r.p ?? a.page;
      const pv = viewer.getPageView(n - 1);
      pushHistory();
      if (pv?.viewport) {
        const [x, y] = pv.viewport.convertToPdfPoint(r.x * pv.viewport.width, Math.max(0, r.y - 0.06) * pv.viewport.height);
        viewer.scrollPageIntoView({ pageNumber: n, destArray: [null, { name: 'XYZ' }, x, y, null], allowNegativeOffset: true });
      } else viewer.currentPageNumber = n;
    },
    back() {
      const h = st.current.history.pop();
      if (!h) return;
      if (h.scale && h.scale !== st.current.viewer.currentScaleValue) st.current.viewer.currentScaleValue = h.scale;
      containerRef.current.scrollTop = h.top;
      containerRef.current.scrollLeft = h.left;
      cbs.current.onHistory?.(st.current.history.length);
    },
    zoom(v) {
      const { viewer } = st.current;
      if (!viewer) return;
      if (v === 'in') viewer.increaseScale();
      else if (v === 'out') viewer.decreaseScale();
      else viewer.currentScaleValue = v;
    },
    find(query, { again = false, prev = false } = {}) {
      st.current.eventBus?.dispatch('find', {
        source: null, type: again ? 'again' : '', query, caseSensitive: false, entireWord: false,
        highlightAll: true, findPrevious: prev, matchDiacritics: false,
      });
    },
    get pageNumber() { return st.current.viewer?.currentPageNumber || 1; },
    get numPages() { return st.current.doc?.numPages || 0; },
    clearSelection() { window.getSelection()?.removeAllRanges(); },
    // Render a horizontal band of a page around PDF-space y, returns dataURL
    async renderRegion(pageNum, y, { height = 340, scale = 1.8 } = {}) {
      const page = await st.current.doc.getPage(pageNum);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const top = y == null ? 0 : Math.max(0, Math.min(vp.height - height, vp.height - y * scale - 24));
      const out = document.createElement('canvas');
      out.width = vp.width; out.height = Math.min(height, vp.height);
      out.getContext('2d').drawImage(canvas, 0, top, vp.width, out.height, 0, 0, vp.width, out.height);
      return out.toDataURL('image/png');
    },
    async getPageText(n) {
      const page = await st.current.doc.getPage(n);
      const tc = await page.getTextContent();
      return tc.items.map(i => i.str + (i.hasEOL ? '\n' : '')).join('');
    },
  }));

  return (
    <div className={`pdf-wrap ${props.dark ? 'pdf-dark' : ''}`}>
      <div ref={containerRef} className="pdf-container">
        <div ref={viewerRef} className="pdfViewer" />
      </div>
    </div>
  );
});
export default PdfView;

function cleanText(s) {
  return s.replace(/-\s*\n\s*(?=[a-z])/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// Merge rects on the same line that touch/overlap
function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.p === r.p && Math.abs(last.y - r.y) < last.h * 0.5 && Math.abs(last.h - r.h) < last.h * 0.6 && r.x <= last.x + last.w + 0.01) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const top = Math.min(last.y, r.y), bottom = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x); last.w = right - last.x; last.y = top; last.h = bottom - top;
    } else out.push({ ...r });
  }
  return out.map(r => ({ p: r.p, x: +r.x.toFixed(5), y: +r.y.toFixed(5), w: +r.w.toFixed(5), h: +r.h.toFixed(5) }));
}
