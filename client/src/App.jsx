import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, subscribe, fmtAuthors } from './api.js';
import Reader from './Reader.jsx';
import NoteEditor, { openNoteWindow } from './NoteEditor.jsx';
import Settings from './Settings.jsx';
import { ItemDetail } from './Library.jsx';
import FolderTree from './FolderTree.jsx';

export default function App() {
  const [tree, setTree] = useState({ folders: [], notes: [], items: [], vault: '' });
  const [view, setView] = useState({ type: 'all' }); // all | starred | trash | folder(path)
  const [items, setItems] = useState([]);
  const [standaloneNotes, setStandaloneNotes] = useState([]);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);   // {kind:'item'|'note', id}
  const [tabs, setTabs] = useState([]);             // open readers [{id,title}]
  const [activeTab, setActiveTab] = useState('library');
  const [settings, setSettings] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [drag, setDrag] = useState(false);
  const [sort, setSort] = useState(() => localStorage.getItem('sort') || 'created');

  const notify = useCallback(t => { setToast(t); setTimeout(() => setToast(''), 3500); }, []);
  const loadTree = useCallback(() => api.get('/api/tree').then(setTree), []);
  // The folder new papers / notes go into: the folder being viewed, else the vault root
  const folder = view.type === 'folder' ? view.path : '';
  const loadItems = useCallback(() => {
    const scope = p => { if (view.type === 'folder') { if (view.path) p.set('folder', view.path); else p.set('view', 'unfiled'); } };
    const p = new URLSearchParams();
    scope(p);
    if (['starred', 'trash'].includes(view.type)) p.set('view', view.type);
    if (q) p.set('q', q);
    api.get(`/api/items?${p}`).then(setItems);
    const np = new URLSearchParams();
    scope(np);
    if (q) np.set('q', q);
    if (view.type === 'all' || view.type === 'folder') api.get(`/api/notes?${np}`).then(setStandaloneNotes);
    else setStandaloneNotes([]);
  }, [view.type, view.path, q]);
  const reloadAll = useCallback(() => Promise.all([loadTree(), loadItems()]), [loadTree, loadItems]);

  useEffect(() => { loadTree(); api.get('/api/settings').then(setSettings); }, [loadTree]);
  useEffect(() => { const t = setTimeout(loadItems, q ? 250 : 0); return () => clearTimeout(t); }, [loadItems, q]);
  useEffect(() => subscribe(m => {
    if (m.type === 'items' || m.type === 'item') { loadItems(); loadTree(); }
    if (m.type === 'tree') { loadTree(); loadItems(); }
    if ((m.type === 'note' && !m.note.item_id) || (m.type === 'note-deleted' && !m.item_id)) loadItems();
    // A note renamed by its heading: keep it selected under its new path
    if (m.type === 'note' && m.renamedFrom) setSelected(s => s?.kind === 'note' && s.id === m.renamedFrom ? { ...s, id: m.note.id } : s);
    if (m.type === 'item' || m.type === 'items') setTabs(ts => ts); // titles refreshed on open
  }), [loadItems, loadTree]);
  // Messages from note windows ("open parent paper")
  useEffect(() => {
    const h = e => { if (e.origin === location.origin && e.data?.type === 'open-item') openItem(e.data.id); };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  });

  async function openItem(id) {
    let it;
    try { it = await api.get(`/api/items/${id}`); } catch (e) { return notify(`打开失败：${e.message}`); }
    if (!it.file && it.kind !== 'web') return notify('该条目没有可阅读的内容');
    setTabs(ts => ts.some(t => t.id === id) ? ts : [...ts, { id, title: it.title }]);
    setActiveTab(id);
  }
  function closeTab(id) {
    setTabs(ts => {
      const i = ts.findIndex(t => t.id === id);
      const next = ts.filter(t => t.id !== id);
      if (activeTab === id) setActiveTab(next[i - 1]?.id || next[i]?.id || 'library');
      return next;
    });
  }
  useEffect(() => {
    const h = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && activeTab !== 'library') { e.preventDefault(); closeTab(activeTab); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  // Refresh tab titles when item metadata changes
  useEffect(() => { setTabs(ts => ts.map(t => ({ ...t, title: items.find(i => i.id === t.id)?.title || t.title }))); }, [items]);

  async function upload(files) {
    const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) return notify('请拖入 PDF 文件');
    const fd = new FormData();
    for (const f of pdfs) fd.append('files', f);
    if (folder) fd.append('folder', folder);
    notify(`正在上传 ${pdfs.length} 个文件…`);
    const res = await api.post('/api/upload', fd).catch(e => [{ error: e.message }]);
    const dup = res.filter(r => r.duplicate).length, err = res.filter(r => r.error);
    notify(`已添加 ${res.length - dup - err.length} 篇${dup ? `，${dup} 篇已存在` : ''}${err.length ? `，${err.length} 个失败：${err[0].error}` : ''}。正在自动索引元数据…`);
    loadItems();
    if (res.length === 1 && res[0].item) setSelected({ kind: 'item', id: res[0].item.id });
  }

  async function newNote() {
    const n = await api.post('/api/notes', { content: '', folder });
    reloadAll();
    setSelected({ kind: 'note', id: n.id });
  }

  const sorted = useMemo(() => {
    const arr = [...items];
    const by = {
      created: (a, b) => b.created - a.created,
      title: (a, b) => a.title.localeCompare(b.title),
      year: (a, b) => (b.year || '').localeCompare(a.year || ''),
      updated: (a, b) => b.updated - a.updated,
    }[sort];
    return arr.sort(by);
  }, [items, sort]);

  const selItem = selected?.kind === 'item' ? items.find(i => i.id === selected.id) || tree.items.find(i => i.id === selected.id) : null;
  // What the tree highlights: the selected paper/note, else the folder being viewed
  const treeSel = selected || (view.type === 'folder' ? { kind: 'folder', path: view.path } : null);
  const viewName = { all: '全部文献', starred: '星标', trash: '回收站' }[view.type] || (view.path ? view.path.split('/').join(' / ') : '根目录（未归类）');

  return (
    <div className="app" onDragOver={e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={e => { if (!e.relatedTarget) setDrag(false); }}
      onDrop={async e => {
        setDrag(false);
        if (e.dataTransfer.files.length) { e.preventDefault(); return upload(e.dataTransfer.files); }
        const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (/^https?:\/\//i.test(url.trim())) {
          e.preventDefault();
          notify('正在抓取网页…');
          try { const it = await api.post('/api/import', { query: url.trim(), folder }); notify(`已导入：${it.title}`); reloadAll(); setSelected({ kind: 'item', id: it.id }); }
          catch (err) { notify(`导入失败：${err.message}`); }
        }
      }}>
      <div className="topbar" onPaste={async e => {
        const txt = e.clipboardData?.getData('text') || '';
        if (activeTab === 'library' && /^https?:\/\/\S+$/i.test(txt.trim())) { setImportOpen(txt.trim()); }
      }}>
        <div className="tabstrip">
          <button className={`tab lib ${activeTab === 'library' ? 'on' : ''}`} onClick={() => setActiveTab('library')}>📚 文库</button>
          {tabs.map(t => (
            <div key={t.id} className={`tab ${activeTab === t.id ? 'on' : ''}`} onClick={() => setActiveTab(t.id)} onAuxClick={e => e.button === 1 && closeTab(t.id)} title={t.title}>
              <span className="tab-title">{t.title}</span>
              <button className="icon" onClick={e => { e.stopPropagation(); closeTab(t.id); }}>✕</button>
            </div>
          ))}
        </div>
        <button className="btn ghost" title="设置" onClick={() => setShowSettings(true)}>⚙</button>
      </div>

      <div className="workspace" style={{ display: activeTab === 'library' ? 'flex' : 'none' }}>
        <aside className="col-left">
          <FolderTree tree={tree} view={view} selected={treeSel} notify={notify} reload={reloadAll}
            setView={v => { setView(v); setSelected(null); }}
            onSelectFolder={path => { setView({ type: 'folder', path }); setSelected(null); }}
            onSelectItem={id => setSelected({ kind: 'item', id })} onOpenItem={openItem}
            onSelectNote={id => setSelected({ kind: 'note', id })} onOpenNote={openNoteWindow} />
        </aside>
        <section className="col-mid">
          <div className="mid-toolbar">
            <b className="view-name">{viewName}</b>
            <span className="spacer" />
            <label className="btn primary">＋ 添加 PDF<input type="file" accept="application/pdf" multiple hidden onChange={e => { upload(e.target.files); e.target.value = ''; }} /></label>
            <button className="btn" onClick={() => setImportOpen(true)} title="arXiv ID / DOI / 标题 / PDF 链接 / 博客网址">＋ 导入链接</button>
            <button className="btn" onClick={newNote}>📝 新笔记</button>
          </div>
          <div className="mid-toolbar">
            <input className="search grow" placeholder="搜索 标题 / 作者 / 标签 / 摘要 / 批注 / 笔记" value={q} onChange={e => setQ(e.target.value)} />
            <select value={sort} onChange={e => { setSort(e.target.value); localStorage.setItem('sort', e.target.value); }}>
              <option value="created">添加时间</option><option value="updated">修改时间</option><option value="title">标题</option><option value="year">年份</option>
            </select>
          </div>
          <div className="item-table">
            <div className="item-row head"><span className="c-star" /><span className="c-title">标题</span><span className="c-auth">作者</span><span className="c-year">年份</span><span className="c-badges" /></div>
            {sorted.map(it => (
              <div key={it.id} className={`item-row ${selected?.id === it.id ? 'sel' : ''}`} draggable
                onDragStart={e => e.dataTransfer.setData('text/x-items', JSON.stringify([{ kind: 'item', id: it.id }]))}
                onClick={() => setSelected({ kind: 'item', id: it.id })} onDoubleClick={() => openItem(it.id)}>
                <span className="c-star" onClick={e => { e.stopPropagation(); api.patch(`/api/items/${it.id}`, { starred: it.starred ? 0 : 1 }).then(loadItems); }}>{it.starred ? '★' : '☆'}</span>
                <span className="c-title">
                  <span className="file-ic">{it.kind === 'web' ? '🌐' : it.file ? '📄' : '📑'}</span>
                  {it.meta_status === 'indexing' || it.meta_status === 'pending' ? <i className="muted">{it.title} · 索引中…</i> : it.title}
                </span>
                <span className="c-auth">{fmtAuthors(it.authors, 1)}</span>
                <span className="c-year">{it.year}</span>
                <span className="c-badges">
                  {it.ann_count > 0 && <span className="badge" title="批注数">✎{it.ann_count}</span>}
                  {it.note_count > 0 && <span className="badge" title="笔记数">📝{it.note_count}</span>}
                </span>
              </div>
            ))}
            {standaloneNotes.map(n => (
              <div key={n.id} className={`item-row ${selected?.id === n.id ? 'sel' : ''}`} draggable
                onDragStart={e => e.dataTransfer.setData('text/x-items', JSON.stringify([{ kind: 'note', id: n.id }]))}
                onClick={() => setSelected({ kind: 'note', id: n.id })} onDoubleClick={() => openNoteWindow(n.id)}>
                <span className="c-star" /><span className="c-title"><span className="file-ic">📝</span>{n.title || '无标题笔记'}</span>
                <span className="c-auth muted">{n.dir || '根目录'}</span><span className="c-year" /><span className="c-badges" />
              </div>
            ))}
            {!sorted.length && !standaloneNotes.length && (
              <div className="empty-big">
                <div className="big">⇩</div>
                <div>把 PDF 拖到这里，或点「添加 PDF」</div>
                <div className="muted small">文件名随意，会自动识别论文标题、作者、年份、摘要、arXiv/DOI 并解析参考文献</div>
              </div>
            )}
          </div>
        </section>
        <aside className="col-right">
          {selItem ? <ItemDetail key={selItem.id} item={selItem} tree={tree} onOpen={() => openItem(selItem.id)} reload={reloadAll} notify={notify}
            onOpenNote={id => setSelected({ kind: 'note', id, parent: selItem.id })} />
            : selected?.kind === 'note' ? <NoteEditor key={selected.id} id={selected.id} onDeleted={() => { setSelected(selected.parent ? { kind: 'item', id: selected.parent } : null); reloadAll(); }}
              onRenamed={nid => { setSelected(s => s && { ...s, id: nid }); reloadAll(); }}
              onBack={selected.parent ? () => setSelected({ kind: 'item', id: selected.parent }) : undefined} onOpenItem={id => openItem(id)} />
              : <div className="empty-hint pad">选择一个条目查看详情。<br /><br />双击打开阅读器 · 把文献拖到左侧文件夹 · 笔记是笔记库里真实的 .md 文件</div>}
        </aside>
      </div>

      {tabs.map(t => (
        <Reader key={t.id} itemId={t.id} settings={settings} visible={activeTab === t.id} onOpenItem={openItem} onItemChanged={() => reloadAll()} />
      ))}

      {importOpen && <ImportDialog initial={typeof importOpen === 'string' ? importOpen : ''} folder={folder} onClose={() => setImportOpen(false)} onDone={it => { setImportOpen(false); notify(`已导入：${it.title}`); reloadAll(); setSelected({ kind: 'item', id: it.id }); }} />}
      {showSettings && <Settings settings={settings} onClose={() => setShowSettings(false)} onSaved={s => { setSettings(s); setShowSettings(false); notify('设置已保存'); }} />}
      {drag && <div className="drop-mask">松开以添加 PDF 到「{viewName}」</div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ImportDialog({ folder, onClose, onDone, initial = '' }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [asWeb, setAsWeb] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try { onDone(await api.post('/api/import', { query: v, folder, as: asWeb ? 'web' : '' })); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <h3>导入</h3>
        <input autoFocus className="grow" value={v} placeholder="arXiv ID / DOI / 论文标题 / PDF 链接 / 博客网址" onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && v && go()} />
        <div className="muted small">
          论文标识会自动查找开放获取 PDF；普通网址会抓取正文，存成可标注的文章（博客、文档、新闻都可以）。
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row">
          {/^https?:\/\//i.test(v) && <label className="chk"><input type="checkbox" checked={asWeb} onChange={e => setAsWeb(e.target.checked)} />作为网页文章抓取</label>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!v || busy} onClick={go}>{busy ? '导入中…' : '导入'}</button>
        </div>
      </div>
    </div>
  );
}
