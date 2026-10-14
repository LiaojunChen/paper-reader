import { useEffect, useState } from 'react';
import { api, subscribe, fmtAuthors, COLORS } from './api.js';
import { openNoteWindow } from './NoteEditor.jsx';

export function ItemDetail({ item, tree, onOpen, reload, notify, onOpenNote }) {
  const [notes, setNotes] = useState([]);
  const [anns, setAnns] = useState([]);
  const [full, setFull] = useState(null);
  useEffect(() => {
    const loadNotes = () => api.get(`/api/notes?item=${item.id}`).then(setNotes);
    loadNotes();
    api.get(`/api/items/${item.id}/annotations`).then(setAnns);
    api.get(`/api/items/${item.id}`).then(setFull);
    return subscribe(m => {
      if ((m.type === 'note' && m.note.item_id === item.id) || (m.type === 'note-deleted' && m.item_id === item.id) || m.type === 'tree') loadNotes();
      if (m.type === 'item' && m.id === item.id) api.get(`/api/items/${item.id}`).then(setFull);
    });
  }, [item.id]);
  const it = full || item;
  const folderOf = tree.items.find(x => x.id === item.id)?.folder ?? it.folder ?? '';
  const newNote = async () => { const n = await api.post('/api/notes', { item_id: item.id, content: `# ${it.title} 笔记\n` }); onOpenNote(n.id); };
  const trash = async () => { await api.patch(`/api/items/${item.id}`, { deleted: 1 }); notify('已移到回收站'); reload(); };
  const restore = async () => { await api.patch(`/api/items/${item.id}`, { deleted: 0 }); reload(); };
  const destroy = async () => {
    if (!confirm('永久删除这篇文献的 PDF 和批注？\n它的笔记文件夹会移到笔记库的 .trash，不会直接删除。')) return;
    await api.del(`/api/items/${item.id}`); reload();
  };
  const moveTo = async folder => { await api.post('/api/move', { folder, itemIds: [item.id] }); notify(`已移到「${folder || '根目录'}」`); reload(); };
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
        {it.deleted ? <><button className="btn" onClick={restore}>恢复</button><button className="btn danger" onClick={destroy}>永久删除</button></> : <button className="btn ghost danger" title="移到回收站" onClick={trash}>删除</button>}
      </div>
      {it.meta_status === 'guessed' && <div className="warn small">未匹配到在线元数据，信息来自 PDF 推断。可在阅读器「信息」页修改标题后重新匹配。</div>}
      <label className="d-folder">
        <span className="muted small">📁 所在文件夹</span>
        <select value={folderOf} onChange={e => moveTo(e.target.value)}>
          <option value="">根目录（未归类）</option>
          {tree.folders.map(f => <option key={f.path} value={f.path}>{f.path.split('/').join(' / ')}</option>)}
        </select>
      </label>
      {it.tags?.length > 0 && <div className="d-colls">{it.tags.map(t => <span key={t} className="tag">#{t}</span>)}</div>}
      {it.abstract && <><div className="d-sec">摘要</div><div className="d-abs">{it.abstract}</div></>}

      <div className="d-sec">子条目</div>
      <div className="children">
        {it.file && <div className="child" onClick={onOpen}>📄 PDF · {it.num_pages || '?'} 页{it.last_page > 1 && <span className="muted tiny"> · 上次读到 p.{it.last_page}</span>}</div>}
        {it.kind === 'web' && <div className="child" onClick={onOpen}>🌐 网页正文 · {it.venue}</div>}
        {notes.map(n => (
          <div key={n.id} className="child" onClick={() => onOpenNote(n.id)} title={n.id}>📝 {n.title || '无标题笔记'}
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
