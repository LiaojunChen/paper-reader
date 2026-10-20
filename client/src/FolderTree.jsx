import { useMemo, useState } from 'react';
import { api } from './api.js';
import { useContextMenu, revealLabel } from './ContextMenu.jsx';

// Obsidian-style directory tree:
//   📁 具身推理
//     📁 规划              ← sub-folder
//     📄 ReAct …           ← paper (expand → its notes; annotations are not shown here)
//       📝 读后笔记
//     📝 综述整理          ← standalone note, sibling of papers
const DRAG = 'text/x-tree';

export default function FolderTree({ tree, selected, onSelectFolder, onSelectItem, onOpenItem, onSelectNote, onOpenNote, onAddPdf, reload, notify, view, setView }) {
  const [open, setOpen] = useState(() => new Set(JSON.parse(localStorage.getItem('openFolders') || '[""]')));
  const [editing, setEditing] = useState(null);     // folder path or `n:<note id>` being renamed
  const [menu, openMenu] = useContextMenu();
  const [over, setOver] = useState(null);
  const toggle = key => setOpen(s => {
    const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key);
    localStorage.setItem('openFolders', JSON.stringify([...n])); return n;
  });

  // Index the flat lists by parent folder
  const idx = useMemo(() => {
    const folders = new Map(), items = new Map(), notes = new Map(), paperNotes = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const f of tree.folders) push(folders, f.parent, f);
    for (const it of tree.items) push(items, it.folder || '', it);
    for (const n of tree.notes) n.itemId ? push(paperNotes, n.itemId, n) : push(notes, n.dir, n);
    for (const l of notes.values()) l.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    for (const l of paperNotes.values()) l.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    return { folders, items, notes, paperNotes };
  }, [tree]);

  const addFolder = async parent => {
    const { path } = await api.post('/api/folders', { parent, name: '新建文件夹' });
    setOpen(s => new Set(s).add(parent));
    await reload();
    setEditing(path);
  };
  const rename = async (path, name) => {
    setEditing(null);
    const cur = path.split('/').pop();
    if (!name.trim() || name.trim() === cur) return;
    try { await api.patch('/api/folders', { path, name: name.trim() }); await reload(); }
    catch (e) { notify(e.message); }
  };
  const removeFolder = async f => {
    if (!confirm(`删除文件夹「${f.name}」？\n其中的笔记会移到笔记库的 .trash；文献不会删除，会移到上一级。`)) return;
    try { await api.del(`/api/folders?path=${encodeURIComponent(f.path)}`); await reload(); } catch (e) { notify(e.message); }
  };
  const newNoteIn = async folder => {
    const n = await api.post('/api/notes', { folder, content: '' });
    setOpen(s => new Set(s).add(folder));
    await reload();
    onSelectNote(n.id);
  };
  const newPaperNote = async it => {
    const n = await api.post('/api/notes', { item_id: it.id, content: `# ${it.title} 笔记\n` });
    setOpen(s => new Set(s).add(`i:${it.id}`));
    await reload();
    onSelectNote(n.id);
  };
  const renameNote = async (n, title) => {
    setEditing(null);
    if (!title.trim() || title.trim() === n.title) return;
    try { await api.put(`/api/note?id=${encodeURIComponent(n.id)}`, { title: title.trim() }); await reload(); }
    catch (e) { notify(e.message); }
  };
  const removeNote = async n => {
    if (!confirm(`删除笔记「${n.title}」？文件会移到笔记库的 .trash 文件夹。`)) return;
    try { await api.del(`/api/note?id=${encodeURIComponent(n.id)}`); await reload(); } catch (e) { notify(e.message); }
  };
  const trashItem = async it => {
    await api.patch(`/api/items/${it.id}`, { deleted: 1 });
    notify('已移到回收站');
    reload();
  };
  const reveal = path => api.post('/api/vault/reveal', { path }).catch(e => notify(e.message));
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => notify(`${what}已复制`));

  // ---- right-click menus ----
  const folderMenu = (e, f) => openMenu(e, [
    { label: '📝 新建笔记', onClick: () => newNoteIn(f.path) },
    { label: '📁 新建子文件夹', onClick: () => addFolder(f.path) },
    onAddPdf && { label: '📄 添加 PDF 到这里…', onClick: () => onAddPdf(f.path) },
    '-',
    { label: '重命名', onClick: () => setEditing(f.path) },
    { label: revealLabel, onClick: () => reveal(f.path) },
    '-',
    { label: '删除文件夹', danger: true, onClick: () => removeFolder(f) },
  ]);
  const rootMenu = e => openMenu(e, [
    { label: '📝 新建笔记', onClick: () => newNoteIn('') },
    { label: '📁 新建文件夹', onClick: () => addFolder('') },
    onAddPdf && { label: '📄 添加 PDF…', onClick: () => onAddPdf('') },
    '-',
    { label: revealLabel, onClick: () => api.post('/api/vault/open') },
  ]);
  const itemMenu = (e, it) => openMenu(e, [
    { label: '📖 阅读', onClick: () => onOpenItem(it.id) },
    { label: '📝 新建笔记', onClick: () => newPaperNote(it) },
    '-',
    { label: '复制 BibTeX', onClick: async () => copy(await api.get(`/api/items/${it.id}/bibtex`), 'BibTeX ') },
    { label: '复制标题', onClick: () => copy(it.title, '标题') },
    '-',
    { label: '移到回收站', danger: true, onClick: () => trashItem(it) },
  ]);
  const noteMenu = (e, n) => openMenu(e, [
    { label: '打开', onClick: () => onSelectNote(n.id) },
    { label: '⧉ 新窗口打开', onClick: () => onOpenNote(n.id) },
    '-',
    { label: '重命名', onClick: () => setEditing(`n:${n.id}`) },
    { label: revealLabel, onClick: () => reveal(n.id) },
    { label: '复制 Obsidian 链接', onClick: () => copy(`[[${n.title}]]`, '链接') },
    '-',
    { label: '删除笔记', danger: true, onClick: () => removeNote(n) },
  ]);

  // ---- drag & drop: papers, notes and folders can be dropped onto a folder ----
  const dragStart = (e, payload) => { e.stopPropagation(); e.dataTransfer.setData(DRAG, JSON.stringify(payload)); e.dataTransfer.effectAllowed = 'move'; };
  const dropOn = target => ({
    onDragOver: e => { if ([...e.dataTransfer.types].includes(DRAG) || [...e.dataTransfer.types].includes('text/x-items')) { e.preventDefault(); e.stopPropagation(); setOver(target); } },
    onDragLeave: e => { e.stopPropagation(); setOver(o => o === target ? null : o); },
    onDrop: async e => {
      e.preventDefault(); e.stopPropagation(); setOver(null);
      const raw = e.dataTransfer.getData(DRAG) || e.dataTransfer.getData('text/x-items');
      if (!raw) return;
      let p = JSON.parse(raw);
      if (Array.isArray(p)) p = { items: p.filter(x => x.kind === 'item').map(x => x.id), notes: p.filter(x => x.kind === 'note').map(x => x.id) };
      try {
        if (p.folder != null) {
          if (target === p.folder || target.startsWith(p.folder + '/')) return;
          await api.patch('/api/folders', { path: p.folder, parent: target });
        } else {
          await api.post('/api/move', { folder: target, itemIds: p.items || [], noteIds: p.notes || [] });
        }
        setOpen(s => new Set(s).add(target));
        await reload();
      } catch (err) { notify(err.message); }
    },
  });

  const pad = d => ({ paddingLeft: `${0.5 + d * 0.95}rem` });

  function renderFolder(path, depth) {
    const subs = idx.folders.get(path) || [];
    const its = idx.items.get(path) || [];
    const nts = idx.notes.get(path) || [];
    return (
      <>
        {subs.map(f => {
          const isOpen = open.has(f.path);
          const isSel = selected?.kind === 'folder' && selected.path === f.path;
          return (
            <div key={`f:${f.path}`}>
              <div className={`tree-row ${isSel ? 'on' : ''} ${over === f.path ? 'over' : ''}`} style={pad(depth)} draggable
                onDragStart={e => dragStart(e, { folder: f.path })} {...dropOn(f.path)} onContextMenu={e => folderMenu(e, f)}
                onClick={() => { onSelectFolder(f.path); if (!isOpen) toggle(f.path); }} onDoubleClick={() => setEditing(f.path)}>
                <span className="twisty" onClick={e => { e.stopPropagation(); toggle(f.path); }}>{isOpen ? '▾' : '▸'}</span>
                <span className="folder">{isOpen ? '📂' : '📁'}</span>
                {editing === f.path
                  ? <input autoFocus defaultValue={f.name} onClick={e => e.stopPropagation()} onBlur={e => rename(f.path, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(null); }} />
                  : <span className="tree-name">{f.name}</span>}
                <span className="tree-acts">
                  <button className="icon" title="新建笔记" onClick={e => { e.stopPropagation(); newNoteIn(f.path); }}>📝</button>
                  <button className="icon" title="新建子文件夹" onClick={e => { e.stopPropagation(); addFolder(f.path); }}>＋</button>
                  <button className="icon" title="删除文件夹" onClick={e => { e.stopPropagation(); removeFolder(f); }}>✕</button>
                </span>
              </div>
              {isOpen && renderFolder(f.path, depth + 1)}
            </div>
          );
        })}
        {its.map(it => {
          const notesOf = idx.paperNotes.get(it.id) || [];
          const key = `i:${it.id}`;
          const isOpen = open.has(key);
          return (
            <div key={key}>
              <div className={`tree-row paper ${selected?.kind === 'item' && selected.id === it.id ? 'on' : ''}`} style={pad(depth)} draggable
                onDragStart={e => dragStart(e, { items: [it.id] })} onContextMenu={e => { onSelectItem(it.id); itemMenu(e, it); }}
                onClick={() => onSelectItem(it.id)} onDoubleClick={() => onOpenItem(it.id)} title={it.title}>
                <span className="twisty" onClick={e => { e.stopPropagation(); if (notesOf.length) toggle(key); }}>{notesOf.length ? (isOpen ? '▾' : '▸') : ''}</span>
                <span className="folder">{it.kind === 'web' ? '🌐' : '📄'}</span>
                <span className="tree-name">{it.title}</span>
                {notesOf.length > 0 && !isOpen && <span className="tree-count">{notesOf.length}</span>}
              </div>
              {isOpen && notesOf.map(n => noteRow(n, depth + 1))}
            </div>
          );
        })}
        {nts.map(n => noteRow(n, depth))}
      </>
    );
  }
  function noteRow(n, depth) {
    return (
      <div key={`n:${n.id}`} className={`tree-row note ${selected?.kind === 'note' && selected.id === n.id ? 'on' : ''}`} style={pad(depth)} draggable
        onDragStart={e => dragStart(e, { notes: [n.id] })} onContextMenu={e => noteMenu(e, n)}
        onClick={() => onSelectNote(n.id)} onDoubleClick={() => onOpenNote(n.id)} title={n.id}>
        <span className="twisty" />
        <span className="folder">📝</span>
        {editing === `n:${n.id}`
          ? <input autoFocus defaultValue={n.title} onClick={e => e.stopPropagation()} onBlur={e => renameNote(n, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(null); }} />
          : <span className="tree-name">{n.title}</span>}
      </div>
    );
  }

  const fixed = [['all', '📚', '全部文献'], ['starred', '★', '星标'], ['trash', '🗑️', '回收站']];
  return (
    <div className="tree">
      {fixed.map(([t, ic, l]) => (
        <div key={t} className={`tree-row ${view.type === t ? 'on' : ''}`} onClick={() => setView({ type: t })}>
          <span className="twisty" /><span className="folder">{ic}</span><span className="tree-name">{l}</span>
        </div>
      ))}
      <div className="tree-sec">
        <span title={tree.vault}>笔记库</span>
        <span>
          <button className="icon" title="在根目录新建笔记" onClick={() => newNoteIn('')}>📝</button>
          <button className="icon" title="新建文件夹" onClick={() => addFolder('')}>＋</button>
          <button className="icon" title="在资源管理器中打开笔记库" onClick={() => api.post('/api/vault/open')}>↗</button>
        </span>
      </div>
      <div className={`tree-root ${over === '' ? 'over' : ''}`} {...dropOn('')} onContextMenu={rootMenu}>
        <div className={`tree-row ${selected?.kind === 'folder' && selected.path === '' ? 'on' : ''}`} style={pad(0)}
          onClick={() => onSelectFolder('')}>
          <span className="twisty" /><span className="folder">🏠</span><span className="tree-name">根目录（未归类）</span>
        </div>
        {renderFolder('', 0)}
        {!tree.folders.length && !tree.notes.length && <div className="muted small pad">点 ＋ 或右键新建文件夹，把文献拖进来。文件夹和笔记都是真实的文件，可以直接用 Obsidian 打开。</div>}
      </div>
      {menu}
    </div>
  );
}
