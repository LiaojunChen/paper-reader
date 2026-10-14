import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { renderMd } from './Markdown.jsx';
import { COLORS } from './api.js';

// Reader for clipped web articles. Mirrors PdfView's API (selection, highlights, hover)
// but anchors annotations to character offsets in the rendered text instead of page rects.
const WebView = forwardRef(function WebView({ item, annotations = [], activeId, dark, ...cbs }, ref) {
  const scroller = useRef(null);
  const body = useRef(null);
  const fns = useRef(cbs);
  fns.current = cbs;
  const html = useMemo(() => renderMd(item.content || ''), [item.content]);

  // ---- offset helpers: map a DOM range to/from plain-text offsets of the article ----
  function textNodes() {
    const out = [];
    const w = document.createTreeWalker(body.current, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue) out.push(n);
    return out;
  }
  function offsetOf(node, off) {
    let total = 0;
    for (const n of textNodes()) {
      if (n === node) return total + off;
      total += n.nodeValue.length;
    }
    return -1;
  }
  function rangeFor(start, end) {
    let total = 0, r = document.createRange(), started = false;
    for (const n of textNodes()) {
      const len = n.nodeValue.length;
      if (!started && start < total + len) { r.setStart(n, start - total); started = true; }
      if (started && end <= total + len) { r.setEnd(n, end - total); return r; }
      total += len;
    }
    return started ? (r.setEndAfter(textNodes().at(-1)), r) : null;
  }

  // ---- paint highlights as absolutely positioned boxes over the text ----
  function draw() {
    const layer = body.current?.parentElement?.querySelector('.hl-layer');
    if (!layer || !body.current) return;
    layer.replaceChildren();
    const base = body.current.getBoundingClientRect();
    for (const a of annotations) {
      const { start, end } = a.rects?.[0] || {};
      if (start == null) continue;
      const r = rangeFor(start, end);
      if (!r) continue;
      for (const cr of r.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const d = document.createElement('div');
        d.className = 'hl' + (a.id === activeId ? ' active' : '');
        d.style.cssText = `left:${cr.left - base.left}px;top:${cr.top - base.top}px;width:${cr.width}px;height:${cr.height}px;--hl:${COLORS[a.color]?.hex || '#ffd400'}`;
        layer.append(d);
      }
    }
  }
  useEffect(() => { draw(); });
  useEffect(() => {
    // Images and fonts change the layout after mount, so repaint on size changes and on image load
    const ro = new ResizeObserver(() => draw());
    if (body.current) ro.observe(body.current);
    const imgs = [...(body.current?.querySelectorAll('img') || [])];
    const onLoad = () => draw();
    for (const im of imgs) if (!im.complete) im.addEventListener('load', onLoad);
    const t1 = setTimeout(draw, 80), t2 = setTimeout(draw, 400), t3 = setTimeout(draw, 1200);
    document.fonts?.ready?.then(draw).catch(() => {});
    return () => {
      ro.disconnect();
      for (const im of imgs) im.removeEventListener('load', onLoad);
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, annotations, activeId]);

  useEffect(() => {
    fns.current.onReady?.({ numPages: 1, outline: headings() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);
  function headings() {
    return [...(body.current?.querySelectorAll('h1,h2,h3') || [])].map(h => ({ title: h.textContent, level: +h.tagName[1], el: h }));
  }

  function annotationAt(x, y) {
    for (const a of annotations) {
      const { start, end } = a.rects?.[0] || {};
      if (start == null) continue;
      const r = rangeFor(start, end);
      if (r && [...r.getClientRects()].some(c => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom)) return a;
    }
    return null;
  }

  // ---- events ----
  useEffect(() => {
    const el = scroller.current;
    let downAt = null;
    const onDown = e => { downAt = { x: e.clientX, y: e.clientY }; fns.current.onPointerDown?.(e); };
    const onUp = e => {
      if (e.button !== 0) return;
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount && body.current.contains(sel.getRangeAt(0).commonAncestorContainer)) {
          const r = sel.getRangeAt(0);
          const start = offsetOf(r.startContainer, r.startOffset), end = offsetOf(r.endContainer, r.endOffset);
          const text = sel.toString().replace(/\s+/g, ' ').trim();
          if (start >= 0 && end > start && text) {
            const cr = r.getBoundingClientRect();
            const anchor = cr.height > 80 ? { left: e.clientX - 40, right: e.clientX + 40, top: e.clientY - 10, bottom: e.clientY + 10 } : cr;
            return fns.current.onSelect?.({ text, page: 1, rects: [{ start, end }], clientRect: anchor });
          }
        }
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
        fns.current.onAnnotationClick?.(annotationAt(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
      }, 0);
    };
    const onScroll = () => fns.current.onScroll?.();
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mouseup', onUp);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('mousedown', onDown); el.removeEventListener('mouseup', onUp); el.removeEventListener('scroll', onScroll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External links open in the browser / new window
  useEffect(() => {
    const el = body.current;
    const h = e => { const a = e.target.closest?.('a[href]'); if (a) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); } };
    el?.addEventListener('click', h);
    return () => el?.removeEventListener('click', h);
  }, [html]);

  useImperativeHandle(ref, () => ({
    goToAnnotation(a) {
      const { start, end } = a.rects?.[0] || {};
      const r = start != null && rangeFor(start, end);
      if (!r) return;
      const cr = r.getBoundingClientRect(), sc = scroller.current.getBoundingClientRect();
      scroller.current.scrollTop += cr.top - sc.top - sc.height * 0.3;
    },
    goToHeading(h) { h.el?.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    back() { scroller.current.scrollTop = 0; },
    zoom(v) {
      const cur = +(body.current.dataset.zoom || 1);
      const n = v === 'in' ? cur + 0.1 : v === 'out' ? cur - 0.1 : 1;
      body.current.dataset.zoom = n;
      body.current.style.fontSize = `${Math.min(2, Math.max(0.7, n))}rem`;
      draw();
    },
    find() { /* browser Ctrl+F works on rendered text */ },
    clearSelection() { window.getSelection()?.removeAllRanges(); },
    get pageNumber() { return 1; },
    get numPages() { return 1; },
  }));

  return (
    <div className={`web-wrap ${dark ? 'web-dark' : ''}`}>
      <div className="web-scroll" ref={scroller}>
        <article className="web-article">
          <header className="web-head">
            <h1>{item.title}</h1>
            <div className="muted small">
              {[item.authors?.join(', '), item.year, item.venue].filter(Boolean).join(' · ')}
              {item.url && <> · <a href={item.url} target="_blank" rel="noreferrer">原文链接</a></>}
            </div>
          </header>
          <div className="hl-holder">
            <div className="hl-layer" />
            <div className="md web-body" ref={body} dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </article>
      </div>
    </div>
  );
});
export default WebView;
