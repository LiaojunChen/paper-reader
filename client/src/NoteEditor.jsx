import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { api, subscribe, CLIENT_ID } from './api.js';
import Markdown from './Markdown.jsx';
import LiveMarkdown from './LiveMarkdown.jsx';

export function openNoteWindow(id) {
  window.open(`/?note=${id}`, `note-${id}`, 'width=760,height=900,menubar=no,toolbar=no');
}

// Cross-window channel: reader → note window ("insert quote")
export const noteChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('paper-reader-notes') : null;

const NoteEditor = forwardRef(function NoteEditor({ id, onTitle, onDeleted, onBack, showOpenWindow = true, onOpenItem }, ref) {
  const [note, setNote] = useState(null);
  const [content, setContent] = useState('');
  const [mode, setMode] = useState(() => localStorage.getItem('noteMode') || 'live');
  const [saved, setSaved] = useState(true);
  const ta = useRef(null);
  const insertFn = useRef(null);   // LiveMarkdown's insert hook
  const timer = useRef(null);
  const latest = useRef('');
  latest.current = content;

  useEffect(() => {
    let live = true;
    api.get(`/api/notes/${id}`).then(n => { if (live) { setNote(n); setContent(n.content); } });
    const off = subscribe(m => {
      if (m.type === 'note' && m.note.id === id && m.origin !== CLIENT_ID && m.note.content !== latest.current) {
        setNote(n => ({ ...n, ...m.note })); setContent(m.note.content);
      }
      if (m.type === 'note-deleted' && m.id === id) onDeleted?.();
    });
    return () => { live = false; off(); flush(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const title = deriveTitle(content);
  useEffect(() => { onTitle?.(title); }, [title, onTitle]);

  function flush() {
    if (!timer.current) return;
    clearTimeout(timer.current); timer.current = null;
    api.patch(`/api/notes/${id}`, { content: latest.current, title: deriveTitle(latest.current) }).then(() => setSaved(true));
  }
  function change(v) {
    setContent(v); setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = 1; flush(); }, 600);
  }
  function insert(text) {
    if (mode === 'live') {
      if (insertFn.current) return insertFn.current(text);
      return change(latest.current.replace(/\s*$/, '') + '\n\n' + text + '\n');
    }
    const el = ta.current;
    const v = latest.current;
    const pos = el && document.activeElement === el ? el.selectionEnd : v.length;
    const pre = v.slice(0, pos), post = v.slice(pos);
    const glue = pre && !pre.endsWith('\n\n') ? (pre.endsWith('\n') ? '\n' : '\n\n') : '';
    const nv = pre + glue + text + '\n' + post;
    change(nv);
    requestAnimationFrame(() => { if (el) { const p = (pre + glue + text + '\n').length; el.focus(); el.setSelectionRange(p, p); el.scrollTop = el.scrollHeight * (p / nv.length) - 100; } });
  }
  useImperativeHandle(ref, () => ({ insert }));

  useEffect(() => {
    if (!noteChannel) return;
    const h = e => { if (e.data?.noteId === id && e.data.text) insert(e.data.text); };
    noteChannel.addEventListener('message', h);
    return () => noteChannel.removeEventListener('message', h);
  });

  const onKey = e => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); timer.current = 1; flush(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target, s = el.selectionStart;
      change(content.slice(0, s) + '  ' + content.slice(el.selectionEnd));
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
  };

  if (!note) return <div className="note-editor"><div className="muted pad">加载中…</div></div>;
  return (
    <div className="note-editor">
      <div className="note-bar">
        {onBack && <button className="btn ghost" onClick={onBack}>← 返回</button>}
        {note.item && <button className="link note-parent" title="打开所属论文" onClick={() => onOpenItem?.(note.item.id)}>📄 {note.item.title}</button>}
        <span className="spacer" />
        <div className="seg">
          {[['live', '实时'], ['edit', '源码'], ['preview', '预览']].map(([k, l]) => (
            <button key={k} className={mode === k ? 'on' : ''} title={k === 'live' ? '实时渲染：点击段落即可编辑' : ''}
              onClick={() => { setMode(k); localStorage.setItem('noteMode', k); }}>{l}</button>
          ))}
        </div>
        <span className="muted tiny">{saved ? '已保存' : '保存中…'}</span>
        {showOpenWindow && <button className="btn ghost" title="新窗口打开（边看论文边记）" onClick={() => { flush(); openNoteWindow(id); }}>⧉</button>}
        <button className="btn ghost danger" title="删除笔记" onClick={async () => { if (confirm('删除这篇笔记？')) { await api.del(`/api/notes/${id}`); onDeleted?.(); } }}>删除</button>
      </div>
      <div className={`note-body ${mode}`} onKeyDown={e => { if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); timer.current = 1; flush(); } }}>
        {mode === 'live' && (
          <div className="note-live">
            <LiveMarkdown value={content} onChange={change} onInsertRef={insertFn}
              placeholder={'点这里开始写…\n\n支持 Markdown 与 LaTeX 公式（$E=mc^2$）。点任意段落即可编辑，空行分隔段落。\n在阅读器中选中文字 →「→笔记」可插入引文。'} />
          </div>
        )}
        {mode === 'edit' && (
          <textarea ref={ta} className="note-text" value={content} spellCheck={false} onChange={e => change(e.target.value)} onKeyDown={onKey} onBlur={() => { if (timer.current) { timer.current = 1; flush(); } }}
            placeholder={'# 标题\n\n支持 Markdown 与 LaTeX 公式：$E=mc^2$'} />
        )}
        {mode === 'preview' && <div className="note-preview"><Markdown text={content || '*空笔记*'} /></div>}
      </div>
    </div>
  );
});
export default NoteEditor;

export function deriveTitle(content) {
  const line = (content || '').split('\n').find(l => l.trim()) || '';
  return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 80) || '无标题笔记';
}
