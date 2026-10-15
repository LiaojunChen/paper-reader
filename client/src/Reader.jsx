import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfView from './PdfView.jsx';
import WebView from './WebView.jsx';
import AnnotationsPanel, { ColorDots } from './Annotations.jsx';
import { CiteCard, RefDetail, refFromDest, invalidateRef } from './refs.jsx';
import { api, stream, subscribe, COLORS, fmtAuthors } from './api.js';
import Markdown from './Markdown.jsx';
import NoteEditor, { openNoteWindow, noteChannel, noteUrl } from './NoteEditor.jsx';
import { ChatPanel, InfoPanel, OutlinePanel } from './ReaderPanels.jsx';
import Splitter, { usePaneWidth } from './Splitter.jsx';

export default function Reader({ itemId, settings, onOpenItem, onItemChanged, visible }) {
  const pdf = useRef(null);
  const [item, setItem] = useState(null);
  const [anns, setAnns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [annMenu, setAnnMenu] = useState(null);   // small toolbar over a clicked highlight
  const [tab, setTab] = useState('annotations');
  const [sel, setSel] = useState(null);           // current text selection
  const [hover, setHover] = useState(null);       // citation hover
  const [cite, setCite] = useState(null);         // side panel citation focus {nums, active, preview}
  const [translation, setTranslation] = useState(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [outline, setOutline] = useState([]);
  const [histLen, setHistLen] = useState(0);
  const [dark, setDark] = useState(() => localStorage.getItem('pdfDark') === '1');
  const [findQ, setFindQ] = useState(null);
  const [findCount, setFindCount] = useState(null);
  const [color, setColor] = useState(() => localStorage.getItem('hlColor') || 'yellow');
  const [notes, setNotes] = useState([]);
  const [noteId, setNoteId] = useState(null);
  const [leftOpen, setLeftOpen] = useState(false);
  // Same keys in every reader tab, so resizing one tab updates the others (see usePaneWidth)
  const sidePane = usePaneWidth('readerSide', +localStorage.getItem('panelW') || 400, { min: 280, max: 1000, reserve: 460 });
  const outlinePane = usePaneWidth('readerOutline', 260, { min: 170, max: 520, reserve: 760 });
  const hoverHide = useRef(null);
  const noteEd = useRef(null);
  const pageSaver = useRef(null);
  const wrapRef = useRef(null);

  // ---- load ----
  useEffect(() => {
    api.get(`/api/items/${itemId}`).then(setItem);
    api.get(`/api/items/${itemId}/annotations`).then(setAnns);
    api.get(`/api/notes?item=${itemId}`).then(setNotes);
  }, [itemId]);
  useEffect(() => subscribe(m => {
    if (m.type === 'annotation' && m.annotation.item_id === itemId && !deletedIds.current.has(m.annotation.id)) setAnns(list => upsert(list, m.annotation));
    if (m.type === 'annotation-deleted' && m.item_id === itemId) setAnns(list => list.filter(a => a.id !== m.id));
    if (m.type === 'item' && m.id === itemId) api.get(`/api/items/${itemId}`).then(setItem);
    if (m.type === 'note' && m.note.item_id === itemId) {
      // Renamed by its heading: replace the old path in the list and keep it open
      if (m.renamedFrom) { setNotes(l => l.filter(n => n.id !== m.renamedFrom)); setNoteId(id => id === m.renamedFrom ? m.note.id : id); }
      setNotes(l => upsert(l, m.note));
    }
    if (m.type === 'tree') api.get(`/api/notes?item=${itemId}`).then(setNotes);
    if (m.type === 'note-deleted' && m.item_id === itemId) { setNotes(l => l.filter(n => n.id !== m.id)); setNoteId(id => id === m.id ? null : id); }
  }), [itemId]);

  const isWeb = item?.kind === 'web';
  const numericRefs = useMemo(() => {
    const r = item?.refs || [];
    return r.length > 2 && r.slice(0, 3).every((x, i) => x.n === i + 1) && !/^[A-Z][a-z]+,/.test(r[0]?.raw || '') ;
  }, [item]);

  // Tombstones: late responses / SSE events for a deleted annotation must not bring it back
  const deletedIds = useRef(new Set());
  const onAnnChanged = useCallback(a => {
    if (a._deleted) { deletedIds.current.add(a.id); setAnns(l => l.filter(x => x.id !== a.id)); setActiveId(id => id === a.id ? null : id); }
    else if (a._restore) { deletedIds.current.delete(a.id); const { _restore, ...rest } = a; setAnns(l => upsert(l, rest)); }
    else if (!deletedIds.current.has(a.id)) setAnns(l => upsert(l, a));
  }, []);
  async function deleteAnn(id) {
    const a = anns.find(x => x.id === id);
    if (!a || !confirm('删除这条批注？')) return;
    onAnnChanged({ id, _deleted: true });
    try { await api.del(`/api/annotations/${id}`); } catch (e) { alert(`删除失败：${e.message}`); onAnnChanged({ ...a, _restore: true }); }
  }

  // ---- create annotation ----
  async function createAnn(extra = {}) {
    if (!sel) return;
    const a = await api.post(`/api/items/${itemId}/annotations`, { page: sel.page, color, text: sel.text, rects: sel.rects, ...extra });
    setAnns(l => upsert(l, a));
    setSel(null); pdf.current?.clearSelection();
    return a;
  }
  async function highlight(c) { if (c) { setColor(c); localStorage.setItem('hlColor', c); } return createAnn(c ? { color: c } : {}); }
  // editId = {id, n}: the card enters edit mode when it sees a new n for its id (works for new and existing cards)
  const editSeq = useRef(0);
  const startEdit = id => setEditId({ id, n: ++editSeq.current });
  async function commentOn() {
    const a = await createAnn();
    if (!a) return;
    setTab('annotations'); setActiveId(a.id); startEdit(a.id);
  }
  async function askAI() {
    const a = await createAnn({ color: 'purple', comment: '解释这段内容，并检索相关工作' });
    if (!a) return;
    setTab('annotations'); setActiveId(a.id);
    onAnnChanged(await api.post(`/api/annotations/${a.id}/ai`));
  }
  function translate(mode = 'translate') {
    if (!sel) return;
    const text = sel.text;
    const ac = new AbortController();
    translation?.ac?.abort();
    setTranslation({ src: text, out: '', mode, loading: true, ac, anchor: sel.clientRect });
    setSel(s => s && { ...s, keep: true });
    stream('/api/translate', { text, mode, context: item?.title }, out => setTranslation(t => t && t.src === text ? { ...t, out } : t), ac.signal)
      .then(() => setTranslation(t => t && t.src === text ? { ...t, loading: false } : t))
      .catch(e => { if (e.name !== 'AbortError') setTranslation(t => t && { ...t, out: `⚠️ ${e.message}`, loading: false }); });
  }
  function toNote(text) {
    const quote = `> ${text}\n>\n> — p.${sel?.page ?? page}`;
    sendToNote(quote);
    setSel(null); pdf.current?.clearSelection();
  }
  async function sendToNote(text) {
    let id = noteId || notes[0]?.id;
    if (!id) {
      const n = await api.post('/api/notes', { item_id: itemId, content: `# ${item?.title || ''} 笔记\n` });
      setNotes(l => upsert(l, n)); id = n.id;
    }
    setNoteId(id);
    // If the note is open in another window, deliver there too
    noteChannel?.postMessage({ noteId: id, text });
    if (tab === 'notes' && noteEd.current) noteEd.current.insert(text);
    else {
      const n = await api.get(noteUrl(id));
      const content = n.content.replace(/\s*$/, '') + '\n\n' + text + '\n';
      await api.put(noteUrl(id), { content });
    }
  }

  // ---- citations ----
  // Numbers to show: the hovered part of a group (ranges expanded), else the whole group, else dest→reference mapping
  const citeNums = info => info.cite?.part || info.cite?.nums
    || (() => { const r = refFromDest(item?.refs, info.pageNum, info.x, info.y); return r ? [r.n] : null; })();
  function onHover(info) {
    clearTimeout(hoverHide.current);
    setHover({ ...info, nums: citeNums(info) });
  }
  function onHoverEnd() {
    clearTimeout(hoverHide.current);
    hoverHide.current = setTimeout(() => setHover(null), 350);
  }
  function openCite(info) {
    const focus = citeNums(info);
    const nums = info.cite?.nums || focus;  // side panel lists the whole group, focused on the clicked one
    setHover(null);
    if (nums?.length) { setCite({ nums, active: focus?.[0] ?? nums[0] }); setTab('cite'); }
    else if (info.pageNum) {
      // not a reference: figure / table / section / equation link → preview in side panel
      setCite({ nums: null, preview: info }); setTab('cite');
    }
  }
  function annotateRef(n, data) {
    api.post(`/api/items/${itemId}/annotations`, {
      page, color: 'purple', text: `[${n}] ${data.meta?.title || data.title || data.raw.slice(0, 160)}`, rects: [], ref_index: n,
      comment: '',
    }).then(a => { setAnns(l => upsert(l, a)); setTab('annotations'); setActiveId(a.id); startEdit(a.id); });
  }

  // ---- keyboard ----
  useEffect(() => {
    if (!visible) return;
    const h = e => {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setFindQ(q => q ?? ''); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); pdf.current?.back(); }
      else if (e.key === 'Escape') { setSel(null); setTranslation(null); setHover(null); setFindQ(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && activeId && !sel) { e.preventDefault(); deleteAnn(activeId); }
      else if (sel && !e.ctrlKey && !e.metaKey) {
        const keys = { h: () => highlight(), c: () => commentOn(), t: () => translate(), e: () => translate('explain'), a: () => askAI(), n: () => toNote(sel.text) };
        const digit = +e.key;
        if (digit >= 1 && digit <= 8) { e.preventDefault(); highlight(Object.keys(COLORS)[digit - 1]); }
        else if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (!item) return <div className="reader"><div className="pad muted">加载中…</div></div>;
  const wrapRect = wrapRef.current?.getBoundingClientRect();
  const pos = (r, w = 420, below = true) => {
    if (!r || !wrapRect) return {};
    const left = Math.max(8, Math.min(wrapRect.width - w - 8, r.left - wrapRect.left));
    const spaceBelow = wrapRect.bottom - r.bottom;
    return below && spaceBelow > 240 ? { left, top: r.bottom - wrapRect.top + 6 } : { left, bottom: wrapRect.bottom - r.top + 6 };
  };

  return (
    <div className="reader" style={{ display: visible ? 'flex' : 'none' }}>
      {leftOpen && <>
        <OutlinePanel outline={outline} pdf={pdf} numPages={numPages} isWeb={isWeb} width={outlinePane.width} onClose={() => setLeftOpen(false)} />
        <Splitter pane={outlinePane} side="left" />
      </>}
      <div className="reader-main">
        <div className="reader-toolbar">
          <button className="btn ghost" title="目录" onClick={() => setLeftOpen(!leftOpen)}>☰</button>
          {!isWeb && <>
            <button className="btn ghost" title="返回跳转前位置 (Alt+←)" disabled={!histLen} onClick={() => pdf.current?.back()}>↩ 返回</button>
            <span className="sep" />
            <input className="page-input" value={page} onChange={e => setPage(e.target.value)} onKeyDown={e => e.key === 'Enter' && pdf.current?.goToPage(+page)} />
            <span className="muted">/ {numPages}</span>
          </>}
          {isWeb && <span className="web-badge" title={item.url}>🌐 {item.venue}</span>}
          <span className="sep" />
          <button className="btn ghost" onClick={() => pdf.current?.zoom('out')}>−</button>
          <button className="btn ghost" onClick={() => pdf.current?.zoom('in')}>＋</button>
          <button className="btn ghost" onClick={() => pdf.current?.zoom(isWeb ? 'reset' : 'page-width')}>{isWeb ? '重置' : '适应宽度'}</button>
          <span className="sep" />
          <ColorDots value={color} onChange={c => { setColor(c); localStorage.setItem('hlColor', c); }} size={14} />
          <span className="spacer" />
          {!isWeb && <button className="btn ghost" title="查找 (Ctrl+F)" onClick={() => setFindQ(q => q === null ? '' : null)}>🔍</button>}
          <button className={`btn ghost ${dark ? 'on' : ''}`} title={isWeb ? '夜间模式' : '夜间模式（反色）'} onClick={() => { setDark(!dark); localStorage.setItem('pdfDark', dark ? '0' : '1'); }}>🌙</button>
          {isWeb
            ? <>
                <a className="btn ghost" href={item.url} target="_blank" rel="noreferrer" title="在浏览器打开原文">↗</a>
                <button className="btn ghost" title="重新抓取原文" onClick={async () => { const it = await api.post(`/api/items/${itemId}/refetch`); setItem(it); }}>⟳</button>
              </>
            : <a className="btn ghost" href={`/api/items/${itemId}/file`} download={`${item.title}.pdf`} title="下载 PDF">⬇</a>}
        </div>
        {findQ !== null && (
          <div className="findbar">
            <input autoFocus value={findQ} placeholder="在文档中查找…" onChange={e => { setFindQ(e.target.value); pdf.current?.find(e.target.value); }}
              onKeyDown={e => { if (e.key === 'Enter') pdf.current?.find(findQ, { again: true, prev: e.shiftKey }); if (e.key === 'Escape') setFindQ(null); }} />
            <span className="muted small">{findCount ? `${findCount.current}/${findCount.total}` : ''}</span>
            <button className="btn ghost" onClick={() => pdf.current?.find(findQ, { again: true, prev: true })}>↑</button>
            <button className="btn ghost" onClick={() => pdf.current?.find(findQ, { again: true })}>↓</button>
            <button className="btn ghost" onClick={() => setFindQ(null)}>✕</button>
          </div>
        )}
        <div className="pdf-area" ref={wrapRef}>
          {isWeb ? (
            <WebView ref={pdf} item={item} annotations={anns} activeId={activeId} dark={dark}
              onReady={({ outline }) => setOutline(outline)}
              onSelect={info => { setSel(info); setHover(null); }}
              onPointerDown={e => { if (!e.target.closest?.('.floating')) { setSel(null); setAnnMenu(null); if (!translation?.pinned) setTranslation(null); } }}
              onAnnotationClick={(a, pt) => { if (a) { setActiveId(a.id); setTab('annotations'); setAnnMenu({ id: a.id, ...pt }); } else { setActiveId(null); setAnnMenu(null); } }}
              onScroll={() => { if (hover) setHover(null); }} />
          ) : (
          <PdfView ref={pdf} url={`/api/items/${itemId}/file`} annotations={anns} activeId={activeId} dark={dark}
            initialPage={item.last_page} numericRefs={numericRefs}
            onReady={({ numPages, outline }) => { setNumPages(numPages); setOutline(outline); }}
            onPageChange={p => {
              setPage(p);
              clearTimeout(pageSaver.current);
              pageSaver.current = setTimeout(() => api.patch(`/api/items/${itemId}`, { last_page: p }), 1500);
            }}
            onHistory={setHistLen}
            onFindCount={c => c && setFindCount(c)}
            onSelect={info => { setSel(info); setHover(null); }}
            onPointerDown={e => { if (!e.target.closest?.('.floating')) { setSel(null); setAnnMenu(null); if (!translation?.pinned) setTranslation(null); } }}
            onAnnotationClick={(a, pt) => { if (a) { setActiveId(a.id); setTab('annotations'); setAnnMenu({ id: a.id, ...pt }); } else { setActiveId(null); setAnnMenu(null); } }}
            onHover={onHover} onHoverEnd={onHoverEnd} onInternalLink={openCite}
            onScroll={() => { if (hover) setHover(null); }} />)}

          {annMenu && !sel && anns.some(a => a.id === annMenu.id) && (
            <div className="floating ann-menu" style={pos({ left: annMenu.x - 20, right: annMenu.x + 20, top: annMenu.y - 6, bottom: annMenu.y + 6 }, 300)} onMouseDown={e => e.stopPropagation()}>
              <ColorDots value={anns.find(a => a.id === annMenu.id)?.color} size={18}
                onChange={c => api.patch(`/api/annotations/${annMenu.id}`, { color: c }).then(onAnnChanged)} />
              <span className="sep" />
              <button onClick={() => { setTab('annotations'); startEdit(annMenu.id); setAnnMenu(null); }}>批注</button>
              <button className="danger" onClick={() => { const id = annMenu.id; setAnnMenu(null); deleteAnn(id); }}>删除</button>
            </div>
          )}
          {sel && !translation && (
            <div className="floating sel-toolbar" style={pos(sel.clientRect, 360)} onMouseDown={e => e.preventDefault()}>
              <ColorDots value={color} onChange={c => highlight(c)} size={16} />
              <span className="sep" />
              <button title="高亮 (H)" onClick={() => highlight()}>高亮</button>
              <button title="批注 (C)" onClick={commentOn}>批注</button>
              <button title="翻译 (T)" onClick={() => translate()}>译</button>
              <button title="解释 (E)" onClick={() => translate('explain')}>释</button>
              <button title="派给 AI (A)" onClick={askAI}>🤖</button>
              <button title="插入笔记 (N)" onClick={() => toNote(sel.text)}>→笔记</button>
              <button title="复制" onClick={() => { navigator.clipboard.writeText(sel.text); setSel(null); }}>复制</button>
            </div>
          )}

          {translation && (
            <div className="floating translate-pop" style={pos(translation.anchor, 460)} onMouseDown={e => e.stopPropagation()}>
              <div className="tp-head">
                <b>{translation.mode === 'explain' ? 'AI 解释' : `翻译 → ${settings.targetLang || '中文'}`}</b>
                {translation.loading && <span className="muted small"> 生成中…</span>}
                <span className="spacer" />
                <button className="link" onClick={() => setTranslation(t => ({ ...t, pinned: !t.pinned }))}>{translation.pinned ? '取消固定' : '固定'}</button>
                <button className="link" onClick={() => navigator.clipboard.writeText(translation.out)}>复制</button>
                <button className="link" onClick={() => { sendToNote(`> ${translation.src}\n\n${translation.out}`); }}>→笔记</button>
                {sel && <button className="link" onClick={async () => { await createAnn({ comment: translation.out, color }); setTranslation(null); }}>存为批注</button>}
                <button className="link" onClick={() => { translation.ac?.abort(); setTranslation(null); }}>✕</button>
              </div>
              <Markdown className="tp-body" text={translation.out || '…'} />
            </div>
          )}

          {hover && (hover.nums?.length || hover.pageNum) && (
            <div className="floating cite-pop" style={pos(hover.rect, 440)}
              onMouseEnter={() => clearTimeout(hoverHide.current)} onMouseLeave={onHoverEnd}>
              {hover.nums?.length ? (
                <>
                  {hover.nums.slice(0, 6).map(n => <CiteCard key={n} itemId={itemId} n={n} compact={hover.nums.length > 1} />)}
                  {hover.nums.length > 6 && <div className="muted small">… 共 {hover.nums.length} 篇</div>}
                  <div className="cite-foot"><button className="link" onClick={() => openCite(hover)}>在侧栏查看详情 →</button><span className="muted tiny">Ctrl+点击 跳转原文</span></div>
                </>
              ) : <DestPreview pdf={pdf} info={hover} onOpen={() => openCite(hover)} />}
            </div>
          )}
        </div>
      </div>

      <Splitter pane={sidePane} side="right" />
      <aside className="reader-side" style={{ width: sidePane.width }}>
        <div className="tabs">
          {[['annotations', `批注 ${anns.length || ''}`], ...(isWeb ? [] : [['cite', '引用']]), ['notes', `笔记 ${notes.length || ''}`], ['chat', 'AI 对话'], ['info', '信息']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="tab-body">
          {tab === 'annotations' && <AnnotationsPanel annotations={anns} activeId={activeId} editId={editId} colorLabels={settings.colorLabels}
            onFocus={a => { setActiveId(a.id); if (a.rects?.length) pdf.current?.goToAnnotation(a); }} onChanged={onAnnChanged} />}
          {tab === 'cite' && (
            !cite ? <div className="empty-hint">点击正文中的引用编号（如 [39]、[29–32]）在这里查看文献详情，不会打断阅读位置。<br />鼠标悬停即可预览。</div>
              : cite.nums ? (
                <div className="cite-panel">
                  {cite.nums.length > 1 && <div className="cite-tabs">{cite.nums.map(n => <button key={n} className={n === cite.active ? 'on' : ''} onClick={() => setCite({ ...cite, active: n })}>[{n}]</button>)}</div>}
                  <RefDetail key={cite.active} itemId={itemId} n={cite.active} onOpenLocal={onOpenItem} onAnnotate={annotateRef}
                    onImported={it => { invalidateRef(itemId, cite.active); onItemChanged?.(it); }} />
                  {cite.nums.length > 1 && cite.nums.filter(n => n !== cite.active).map(n => (
                    <div key={n} className="cite-mini" onClick={() => setCite({ ...cite, active: n })}><CiteCard itemId={itemId} n={n} compact /></div>
                  ))}
                  <div className="cite-jump"><button className="link" onClick={() => { const r = item.refs.find(x => x.n === cite.active); if (r?.p) pdf.current?.goToPage(r.p); }}>跳到参考文献列表 ↗</button></div>
                </div>
              ) : <DestPreview pdf={pdf} info={cite.preview} large onOpen={() => pdf.current?.goToDest(cite.preview.dest, cite.preview.pageNum)} />
          )}
          {tab === 'notes' && (noteId
            ? <NoteEditor ref={noteEd} key={noteId} id={noteId} onBack={() => setNoteId(null)} onDeleted={() => setNoteId(null)}
                onRenamed={(nid, old) => { setNotes(l => l.filter(n => n.id !== old)); setNoteId(nid); }} />
            : <NoteList notes={notes} onOpen={setNoteId} onNew={async () => {
                const n = await api.post('/api/notes', { item_id: itemId, content: `# ${item.title} 笔记\n` });
                setNotes(l => upsert(l, n)); setNoteId(n.id);
              }} />)}
          {tab === 'chat' && <ChatPanel item={item} onToNote={sendToNote} />}
          {tab === 'info' && <InfoPanel item={item} onChange={it => { setItem(it); onItemChanged?.(it); }} />}
        </div>
      </aside>
    </div>
  );
}

function NoteList({ notes, onOpen, onNew }) {
  return (
    <div className="note-list">
      <button className="btn primary block" onClick={onNew}>＋ 新建笔记</button>
      {!notes.length && <div className="empty-hint">笔记归属于这篇论文。点 ⧉ 可在新窗口打开，边看边记；选中文字点「→笔记」可插入引文。</div>}
      {notes.map(n => (
        <div key={n.id} className="note-row" onClick={() => onOpen(n.id)}>
          <div className="note-title">📝 {n.title || '无标题笔记'}</div>
          <div className="muted tiny">{new Date(n.updated).toLocaleString('zh-CN')}</div>
          <button className="icon" title="新窗口打开" onClick={e => { e.stopPropagation(); openNoteWindow(n.id); }}>⧉</button>
        </div>
      ))}
    </div>
  );
}

// Preview of a figure / table / section destination without leaving the current position
function DestPreview({ pdf, info, onOpen, large }) {
  const [img, setImg] = useState(null);
  useEffect(() => {
    let live = true;
    setImg(null);
    pdf.current?.renderRegion(info.pageNum, info.y, { height: large ? 520 : 300, scale: large ? 2 : 1.5 }).then(u => live && setImg(u)).catch(() => {});
    return () => { live = false; };
  }, [info.pageNum, info.y, large, pdf]);
  return (
    <div className="dest-preview">
      <div className="dp-head"><span className="muted small">第 {info.pageNum} 页</span><span className="spacer" /><button className="link" onClick={onOpen}>跳转 →</button></div>
      {img ? <img src={img} alt={`第 ${info.pageNum} 页预览`} /> : <div className="muted small pad">渲染中…</div>}
    </div>
  );
}

function upsert(list, x) {
  const i = list.findIndex(y => y.id === x.id);
  if (i < 0) return [...list, x];
  const out = list.slice(); out[i] = { ...out[i], ...x }; return out;
}
