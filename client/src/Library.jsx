import { useEffect, useState } from 'react';
import { api, subscribe, fmtAuthors, COLORS } from './api.js';
import { openNoteWindow } from './NoteEditor.jsx';

export function CollectionTree({ collections, view, setView, reload, onDropItems }) {
  const [open, setOpen] = useState(() => new Set(JSON.parse(localStorage.getItem('openColls') || '[]')));
  const [editing, setEditing] = useState(null);
  const [over, setOver] = useState(null);
  const toggle = id => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); localStorage.setItem('openColls', JSON.stringify([...n])); return n; });
  const add = async parent_id => {
    const c = await api.post('/api/collections', { name: '新建分类', parent_id });
    if (parent_id) setOpen(s => new Set(s).add(parent_id));
    await reload(); setEditing(c.id);
  };
  const rename = async (id, name) => { setEditing(null); if (name.trim()) { await api.patch(`/api/collections/${id}`, { name: name.trim() }); reload(); } };
  const remove = async c => {
    if (!confirm(`删除分类「${c.name}」及其子分类？（论文本身不会被删除）`)) return;
    await api.del(`/api/collections/${c.id}`);
    if (view.id === c.id) setView({ type: 'all' });
    reload();
  };
  const dropProps = (target, fn) => ({
    onDragOver: e => { e.preventDefault(); setOver(target); },
    onDragLeave: () => setOver(o => o === target ? null : o),
    onDrop: e => { e.preventDefault(); setOver(null); fn(e); },
  });
  const onDrop = cid => e => {
    const items = e.dataTransfer.getData('text/x-items');
    const coll = e.dataTransfer.getData('text/x-collection');
    if (items) onDropItems(cid, JSON.parse(items));
    else if (coll && coll !== cid) api.patch(`/api/collections/${coll}`, { parent_id: cid }).then(reload);
  };
  const children = pid => collections.filter(c => (c.parent_id || null) === pid);
  const node = (c, depth) => {
    const kids = children(c.id);
    const isOpen = open.has(c.id);
    return (
      <div key={c.id}>
        <div className={`tree-row ${view.id === c.id ? 'on' : ''} ${over === c.id ? 'over' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}
          draggable onDragStart={e => e.dataTransfer.setData('text/x-collection', c.id)} {...dropProps(c.id, onDrop(c.id))}
          onClick={() => setView({ type: 'collection', id: c.id })} onDoubleClick={() => setEditing(c.id)}>
          <span className="twisty" onClick={e => { e.stopPropagation(); toggle(c.id); }}>{kids.length ? (isOpen ? '▾' : '▸') : ''}</span>
          <span className="folder">📁</span>
          {editing === c.id
            ? <input autoFocus defaultValue={c.name} onClick={e => e.stopPropagation()} onBlur={e => rename(c.id, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(null); }} />
            : <span className="tree-name">{c.name}</span>}
          <span className="tree-acts">
            <button className="icon" title="新建子分类" onClick={e => { e.stopPropagation(); add(c.id); }}>＋</button>
            <button className="icon" title="删除" onClick={e => { e.stopPropagation(); remove(c); }}>✕</button>
          </span>
        </div>
        {isOpen && kids.map(k => node(k, depth + 1))}
      </div>
    );
  };
  const fixed = [['all', '📚', '我的文库'], ['starred', '★', '星标'], ['unfiled', '📂', '未分类'], ['trash', '🗑️', '回收站']];
  return (
    <div className="tree">
      {fixed.map(([t, ic, l]) => (
        <div key={t} className={`tree-row ${view.type === t ? 'on' : ''} ${over === t ? 'over' : ''}`} onClick={() => setView({ type: t })}
          {...(t === 'all' ? dropProps('all', e => { const c = e.dataTransfer.getData('text/x-collection'); if (c) api.patch(`/api/collections/${c}`, { parent_id: null }).then(reload); }) : {})}>
          <span className="twisty" /><span className="folder">{ic}</span><span className="tree-name">{l}</span>
        </div>
      ))}
      <div className="tree-sec"><span>分类</span><button className="icon" title="新建分类" onClick={() => add(null)}>＋</button></div>
      {children(null).map(c => node(c, 0))}
      {!collections.length && <div className="muted small pad">点 ＋ 新建分类，把论文拖进来</div>}
    </div>
  );
}

export function ItemDetail({ item, collections, view, onOpen, reload, notify, onOpenNote }) {
  const [notes, setNotes] = useState([]);
  const [anns, setAnns] = useState([]);
  const [full, setFull] = useState(null);
  useEffect(() => {
    api.get(`/api/notes?item=${item.id}`).then(setNotes);
    api.get(`/api/items/${item.id}/annotations`).then(setAnns);
    api.get(`/api/items/${item.id}`).then(setFull);
    return subscribe(m => {
      if ((m.type === 'note' && m.note.item_id === item.id) || (m.type === 'note-deleted' && m.item_id === item.id)) api.get(`/api/notes?item=${item.id}`).then(setNotes);
      if (m.type === 'item' && m.id === item.id) api.get(`/api/items/${item.id}`).then(setFull);
    });
  }, [item.id]);
  const it = full || item;
  const newNote = async () => { const n = await api.post('/api/notes', { item_id: item.id, content: `# ${it.title} 笔记\n` }); onOpenNote(n.id); };
  const trash = async () => { await api.patch(`/api/items/${item.id}`, { deleted: 1 }); notify('已移到回收站'); reload(); };
  const restore = async () => { await api.patch(`/api/items/${item.id}`, { deleted: 0 }); reload(); };
  const destroy = async () => { if (confirm('永久删除该论文、PDF 及其批注和笔记？此操作不可恢复。')) { await api.del(`/api/items/${item.id}`); reload(); } };
  const removeFromColl = async () => { await api.del(`/api/collections/${view.id}/items/${item.id}`); reload(); };
  const colls = (it.collection_ids || []).map(id => collections.find(c => c.id === id)?.name).filter(Boolean);
  return (
    <div className="item-detail">
      <h2 className="d-title">{it.title}</h2>
      <div className="d-authors">{fmtAuthors(it.authors, 12)}</div>
      <div className="d-meta">{[it.year, it.venue].filter(Boolean).join(' · ')}</div>
      <div className="d-actions">
        {(it.file || it.kind === 'web') && <button className="btn primary" onClick={onOpen}>📖 阅读</button>}
        <button className="btn" onClick={newNote}>📝 添加笔记</button>
        {it.arxiv && <a className="btn" href={`https://arxiv.org/abs/${it.arxiv}`} target="_blank" rel="noreferrer">arXiv</a>}
        {it.doi && <a className="btn" href={`https://doi.org/${it.doi}`} target="_blank" rel="noreferrer">DOI</a>}
        <button className="btn" onClick={async () => { navigator.clipboard.writeText(await api.get(`/api/items/${item.id}/bibtex`)); notify('BibTeX 已复制'); }}>BibTeX</button>
        {view.type === 'collection' && <button className="btn" onClick={removeFromColl}>移出分类</button>}
        {it.deleted ? <><button className="btn" onClick={restore}>恢复</button><button className="btn danger" onClick={destroy}>永久删除</button></> : <button className="btn ghost danger" title="移到回收站" onClick={trash}>删除</button>}
      </div>
      {it.meta_status === 'guessed' && <div className="warn small">未匹配到在线元数据，信息来自 PDF 推断。可在阅读器「信息」页修改标题后重新匹配。</div>}
      {colls.length > 0 && <div className="d-colls">{colls.map(c => <span key={c} className="tag">📁 {c}</span>)}</div>}
      {it.tags?.length > 0 && <div className="d-colls">{it.tags.map(t => <span key={t} className="tag">#{t}</span>)}</div>}
      {it.abstract && <><div className="d-sec">摘要</div><div className="d-abs">{it.abstract}</div></>}

      <div className="d-sec">子条目</div>
      <div className="children">
        {it.file && <div className="child" onClick={onOpen}>📄 PDF · {it.num_pages || '?'} 页{it.last_page > 1 && <span className="muted tiny"> · 上次读到 p.{it.last_page}</span>}</div>}
        {notes.map(n => (
          <div key={n.id} className="child" onClick={() => onOpenNote(n.id)}>📝 {n.title || '无标题笔记'}
            <button className="icon" title="新窗口打开" onClick={e => { e.stopPropagation(); openNoteWindow(n.id); }}>⧉</button>
          </div>
        ))}
      </div>
      {anns.length > 0 && (
        <>
          <div className="d-sec">批注 {anns.length}</div>
          <div className="d-anns">
            {anns.slice(0, 30).map(a => (
              <div key={a.id} className="d-ann" style={{ borderColor: COLORS[a.color]?.hex }} onClick={onOpen}>
                {a.text && <div className="q">{a.text.slice(0, 160)}</div>}
                {a.comment && <div className="c">{a.comment.slice(0, 160)}</div>}
                {a.ai_reply && <div className="c ai">🤖 {a.ai_reply.slice(0, 120)}…</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
