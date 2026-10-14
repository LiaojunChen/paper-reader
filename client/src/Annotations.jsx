import { useEffect, useMemo, useRef, useState } from 'react';
import { api, COLORS, fmtDate } from './api.js';
import Markdown from './Markdown.jsx';

export function ColorDots({ value, onChange, size = 16 }) {
  return (
    <div className="color-dots">
      {Object.entries(COLORS).map(([k, c]) => (
        <button key={k} title={c.name} className={`dot ${value === k ? 'on' : ''}`} style={{ background: c.hex, width: size, height: size }}
          onMouseDown={e => e.preventDefault()} onClick={() => onChange(k)} />
      ))}
    </div>
  );
}

const STATUS = { running: '🤖 AI 处理中…', done: '🤖 AI 已回复', error: '⚠️ AI 任务失败', cancelled: '已取消' };

export function AnnotationCard({ a, active, onFocus, onChange, onDelete, onAI, onCancel, autoEdit }) {
  const [editing, setEditing] = useState(!!autoEdit);
  const [draft, setDraft] = useState(a.comment);
  const [showLog, setShowLog] = useState(false);
  const [instr, setInstr] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const ref = useRef(null);
  const ta = useRef(null);
  useEffect(() => { if (!editing) setDraft(a.comment); }, [a.comment, editing]);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [active]);
  useEffect(() => { if (autoEdit) { setEditing(true); ref.current?.scrollIntoView({ block: 'nearest' }); } }, [autoEdit]);
  useEffect(() => { if (editing) ta.current?.focus(); }, [editing]);
  const deleting = useRef(false);
  const save = () => { setEditing(false); if (!deleting.current && draft !== a.comment) onChange({ comment: draft }); };
  const remove = e => {
    e.stopPropagation();
    deleting.current = true;   // the click blurs the textarea first; don't save a card that's being deleted
    if (confirm('删除这条批注？')) onDelete(a); else deleting.current = false;
  };
  const hex = COLORS[a.color]?.hex || '#ffd400';
  return (
    <div ref={ref} className={`sticker ${active ? 'active' : ''}`} style={{ '--c': hex }} onClick={() => onFocus(a)}>
      <div className="sticker-top">
        <span className="pg">{a.rects?.[0]?.start != null ? '网页' : `p.${a.page}`}</span>
        <ColorDots value={a.color} size={11} onChange={c => onChange({ color: c })} />
        <span className="spacer" />
        <button className="icon" title="删除 (Delete)" onMouseDown={() => { deleting.current = true; }} onClick={remove}>✕</button>
      </div>
      {a.text && <blockquote className="sticker-quote">{a.text}</blockquote>}
      {editing ? (
        <textarea ref={ta} className="sticker-input" value={draft} placeholder="写下批注 / 问 AI 的问题…（Ctrl+Enter 保存，Ctrl+Shift+Enter 保存并派给 AI）"
          onClick={e => e.stopPropagation()} onChange={e => setDraft(e.target.value)} onBlur={save}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault(); setEditing(false);
              onChange({ comment: draft }).then(() => e.shiftKey && onAI(a));
            } else if (e.key === 'Escape') { setDraft(a.comment); setEditing(false); }
          }} />
      ) : (
        <div className={`sticker-comment ${a.comment ? '' : 'empty'}`} onDoubleClick={() => setEditing(true)}
          onClick={e => { if (!a.comment) { e.stopPropagation(); setEditing(true); } }}>
          {a.comment ? <Markdown text={a.comment} /> : '添加批注…'}
        </div>
      )}
      {(a.ai_status || a.ai_reply) && (
        <div className={`ai-box ${a.ai_status}`} onClick={e => e.stopPropagation()}>
          <div className="ai-head">
            <span>{STATUS[a.ai_status] || '🤖 AI'}</span>
            <span className="spacer" />
            {a.ai_log && <button className="link" onClick={() => setShowLog(!showLog)}>{showLog ? '隐藏过程' : '过程'}</button>}
            {a.ai_status === 'running' && <button className="link" onClick={() => onCancel(a)}>取消</button>}
          </div>
          {a.ai_status === 'running' && <div className="ai-progress">{(a.ai_log || '').split('\n').slice(-1)[0]}</div>}
          {showLog && <pre className="ai-log">{a.ai_log}</pre>}
          {a.ai_reply && <Markdown className="ai-reply" text={a.ai_reply} />}
        </div>
      )}
      <div className="sticker-actions" onClick={e => e.stopPropagation()}>
        <button className="link" onClick={() => setEditing(true)}>编辑</button>
        {a.ai_status !== 'running' && (
          <>
            <button className="link ai" title="派给 AI：自动检索并在此回复" onClick={() => onAI(a)}>{a.ai_reply ? '🤖 重新派给 AI' : '🤖 派给 AI'}</button>
            {a.ai_reply && <button className="link" onClick={() => setAskOpen(!askOpen)}>追问</button>}
          </>
        )}
        <span className="spacer" />
        <span className="muted tiny">{fmtDate(a.updated)}</span>
      </div>
      {askOpen && (
        <div className="followup" onClick={e => e.stopPropagation()}>
          <input value={instr} placeholder="追问 AI，例如：再对比一下 CAMEL 的做法" onChange={e => setInstr(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && instr.trim()) { onAI(a, instr); setInstr(''); setAskOpen(false); } }} />
        </div>
      )}
    </div>
  );
}

export default function AnnotationsPanel({ annotations, activeId, editId, onFocus, onChanged, colorLabels }) {
  const [q, setQ] = useState('');
  const [color, setColor] = useState('');
  const [onlyAI, setOnlyAI] = useState(false);
  const list = useMemo(() => annotations.filter(a =>
    (!color || a.color === color) && (!onlyAI || a.ai_status || a.ai_reply) &&
    (!q || (a.text + a.comment + a.ai_reply).toLowerCase().includes(q.toLowerCase()))
  ).sort((x, y) => x.page - y.page || (x.rects?.[0]?.y ?? 0) - (y.rects?.[0]?.y ?? 0)), [annotations, q, color, onlyAI]);

  // Responses for an annotation deleted meanwhile are dropped (onChanged ignores tombstoned ids)
  const safe = p => p.then(r => r && r.id && onChanged(r)).catch(e => { if (!/已删除|未找到/.test(e.message)) alert(e.message); });
  const patch = (a, p) => safe(api.patch(`/api/annotations/${a.id}`, p));
  const del = async a => {
    onChanged({ id: a.id, _deleted: true });            // optimistic: remove immediately
    try { await api.del(`/api/annotations/${a.id}`); }
    catch (e) { alert(`删除失败：${e.message}`); onChanged({ ...a, _restore: true }); }
  };
  const ai = (a, instruction) => safe(api.post(`/api/annotations/${a.id}/ai`, { instruction }));
  const cancel = a => safe(api.post(`/api/annotations/${a.id}/ai/cancel`));
  const runningCount = annotations.filter(a => a.ai_status === 'running').length;
  const counts = useMemo(() => { const c = {}; for (const a of annotations) c[a.color] = (c[a.color] || 0) + 1; return c; }, [annotations]);

  return (
    <div className="ann-panel">
      <div className="panel-tools">
        <input className="search" placeholder="搜索批注…" value={q} onChange={e => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={onlyAI} onChange={e => setOnlyAI(e.target.checked)} />AI</label>
      </div>
      <div className="color-filter">
        <button className={`chip ${!color ? 'on' : ''}`} onClick={() => setColor('')}>全部 {annotations.length}</button>
        {Object.entries(COLORS).filter(([k]) => counts[k]).map(([k, c]) => (
          <button key={k} className={`chip ${color === k ? 'on' : ''}`} onClick={() => setColor(color === k ? '' : k)}>
            <i style={{ background: c.hex }} />{colorLabels?.[k] || c.name} {counts[k]}
          </button>
        ))}
      </div>
      {runningCount > 0 && <div className="ai-running-banner">🤖 {runningCount} 个 AI 任务进行中</div>}
      <div className="stickers">
        {!list.length && <div className="empty-hint">选中文字即可高亮/批注。<br />在批注里写问题，点「🤖 派给 AI」，AI 会自动检索并回复在批注里；也可以写"帮我下载这篇论文"。</div>}
        {list.map(a => (
          <AnnotationCard key={a.id} a={a} active={a.id === activeId} autoEdit={editId?.id === a.id ? editId.n : 0} onFocus={onFocus}
            onChange={p => patch(a, p)} onDelete={del} onAI={ai} onCancel={cancel} />
        ))}
      </div>
    </div>
  );
}
