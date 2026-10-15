import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, decode, uid, now, update, getSettings, setSettings, FILES_DIR, TEXT_DIR } from './db.js';
import { extractPdf, fullText, guessFromFirstPage, parseReferences } from './pdftext.js';
import { resolvePaper, titleFromReference, downloadPdf, configureSources, sourceStatus } from './metadata.js';
import { fetchArticle } from './webclip.js';
import { runTask, cancelTask, setBroadcaster, isRunning } from './agent.js';
import { chat } from './llm.js';
import * as vault from './vault.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
const upload = multer({ dest: path.join(FILES_DIR, '_tmp'), limits: { fileSize: 300 * 1024 * 1024 } });
// In the packaged app the client build sits outside the asar archive
const ROOT = process.env.PAPER_ROOT ? path.resolve(process.env.PAPER_ROOT) : path.resolve(import.meta.dirname, '..');

// ---------- Server-sent events for live updates ----------
const clients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
setBroadcaster(broadcast);
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': hi\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message || String(e) });
});
const notFound = () => Object.assign(new Error('未找到'), { status: 404 });

// ---------- Folders (real directories in the vault) ----------
// A paper's `folder` is the category directory it belongs to; its own note folder lives inside it.
const underFolder = (f, root) => !root || f === root || f.startsWith(root + '/');
const reFolder = (f, from, to) => f === from ? to : to + f.slice(from.length);
function syncItemFolders() {
  // Keep items.folder in step with where their paper folders actually are (handles moves made in Obsidian)
  const { paperDirs, folders } = vault.scan();
  const known = new Set(folders.map(x => x.path));
  for (const it of db.prepare('SELECT id, folder FROM items').all()) {
    const dir = paperDirs.get(it.id);
    let f = it.folder;
    if (dir != null) f = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    else if (f && !known.has(f)) f = '';               // its category folder was deleted/renamed outside the app
    if (f !== it.folder) db.prepare('UPDATE items SET folder = ? WHERE id = ?').run(f, it.id);
  }
}
app.get('/api/tree', (req, res) => {
  syncItemFolders();
  const { folders, notes } = vault.scan();
  const items = db.prepare("SELECT id, title, kind, folder, file FROM items WHERE deleted = 0 ORDER BY title COLLATE NOCASE").all();
  res.json({ vault: vault.getVaultDir(), folders, notes: notes.map(({ id, title, dir, itemId, mtime }) => ({ id, title, dir, itemId, mtime })), items });
});
app.post('/api/folders', wrap(async (req, res) => {
  const rel = vault.createFolder(req.body.parent || '', req.body.name || '新建文件夹');
  broadcast({ type: 'tree' });
  res.json({ path: rel });
}));
// Rename / move a folder: papers inside follow along
app.patch('/api/folders', wrap(async (req, res) => {
  const from = String(req.body.path || '');
  if (!from) throw Object.assign(new Error('不能重命名根目录'), { status: 400 });
  const to = vault.moveFolder(from, { name: req.body.name, parent: req.body.parent });
  const st = db.prepare('UPDATE items SET folder = ? WHERE id = ?');
  for (const it of db.prepare('SELECT id, folder FROM items').all()) if (underFolder(it.folder, from)) st.run(reFolder(it.folder, from, to), it.id);
  broadcast({ type: 'tree' }); broadcast({ type: 'items' });
  res.json({ path: to });
}));
// Delete a folder: notes go to the vault's .trash; papers move up to the parent folder (never deleted)
app.delete('/api/folders', wrap(async (req, res) => {
  const rel = String(req.query.path || '');
  if (!rel) throw Object.assign(new Error('不能删除根目录'), { status: 400 });
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  for (const it of db.prepare('SELECT id, folder FROM items').all()) {
    if (!underFolder(it.folder, rel)) continue;
    vault.movePaperDir(it.id, parent);   // keep the paper's own notes with it
    db.prepare('UPDATE items SET folder = ? WHERE id = ?').run(parent, it.id);
  }
  vault.trashPath(rel);
  broadcast({ type: 'tree' }); broadcast({ type: 'items' });
  res.json({ ok: true });
}));
// Move papers and/or notes into a folder
app.post('/api/move', wrap(async (req, res) => {
  const folder = String(req.body.folder || '');
  vault.ensureFolder(folder);
  for (const id of req.body.itemIds || []) {
    vault.movePaperDir(id, folder);
    db.prepare('UPDATE items SET folder = ?, updated = ? WHERE id = ?').run(folder, now(), id);
  }
  for (const id of req.body.noteIds || []) vault.moveNote(id, { dir: folder });
  broadcast({ type: 'tree' }); broadcast({ type: 'items' });
  res.json({ ok: true });
}));

// ---------- Items ----------
const LIST_COLS = `i.id, i.title, i.authors, i.year, i.venue, i.doi, i.arxiv, i.url, i.file, i.tags, i.meta_status, i.kind, i.folder,
  i.starred, i.deleted, i.created, i.updated, i.last_page, i.num_pages,
  (SELECT COUNT(*) FROM annotations a WHERE a.item_id = i.id) AS ann_count`;

// ?folder=具身推理 lists that folder and its sub-folders; ?view=unfiled = vault root only
app.get('/api/items', (req, res) => {
  const { folder, q, view } = req.query;
  syncItemFolders();
  const where = [], args = [];
  if (view === 'trash') where.push('i.deleted = 1'); else where.push('i.deleted = 0');
  if (view === 'starred') where.push('i.starred = 1');
  if (view === 'unfiled') where.push("i.folder = ''");
  if (folder) { where.push('(i.folder = ? OR i.folder LIKE ?)'); args.push(folder, `${folder}/%`); }
  // Notes live in files, so note matches are found in the vault and merged in by id
  const noteHits = q ? new Set(vault.searchNotes(q).map(n => n.itemId).filter(Boolean)) : null;
  if (q) {
    where.push(`(i.title LIKE ? OR i.authors LIKE ? OR i.tags LIKE ? OR i.abstract LIKE ? OR i.venue LIKE ?
      OR EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = i.id AND (a.text LIKE ? OR a.comment LIKE ?))
      ${noteHits.size ? `OR i.id IN (${[...noteHits].map(() => '?').join(',')})` : ''})`);
    args.push(...Array(7).fill(`%${q}%`), ...noteHits);
  }
  const counts = noteCounts();
  const rows = db.prepare(`SELECT ${LIST_COLS} FROM items i WHERE ${where.join(' AND ')} ORDER BY i.created DESC`).all(...args);
  res.json(rows.map(r => ({ ...decode(r), note_count: counts.get(r.id) || 0 })));
});
function noteCounts() {
  const m = new Map();
  for (const n of vault.scan().notes) if (n.itemId) m.set(n.itemId, (m.get(n.itemId) || 0) + 1);
  return m;
}

const getItem = id => decode(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
app.get('/api/items/:id', (req, res) => {
  const it = getItem(req.params.id);
  if (!it) return res.status(404).json({ error: '未找到' });
  it.note_dir = vault.paperDir(it.id);
  res.json(it);
});
app.patch('/api/items/:id', (req, res) => {
  update('items', req.params.id, req.body, ['title', 'authors', 'year', 'venue', 'abstract', 'doi', 'arxiv', 'url', 'tags', 'starred', 'deleted', 'last_page', 'content']);
  // Keep the paper's note folder named after its (possibly corrected) title
  if (typeof req.body.title === 'string') {
    const dir = vault.paperDir(req.params.id);
    if (dir != null) { try { vault.moveFolder(dir, { name: req.body.title }); broadcast({ type: 'tree' }); } catch { /* name clash etc. */ } }
  }
  const it = getItem(req.params.id);
  if (Object.keys(req.body).some(k => k !== 'last_page')) broadcast({ type: 'items' });
  res.json(it);
});
app.delete('/api/items/:id', (req, res) => {
  const it = getItem(req.params.id);
  if (!it) return res.json({ ok: true });
  // The paper's notes are user content: move its folder to the vault trash rather than deleting
  const dir = vault.paperDir(it.id);
  if (dir != null) vault.trashPath(dir);
  if (it.file) fs.rmSync(path.join(FILES_DIR, it.file), { force: true });
  fs.rmSync(path.join(TEXT_DIR, `${it.id}.txt`), { force: true });
  db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
  broadcast({ type: 'items' });
  res.json({ ok: true });
});
app.get('/api/items/:id/file', (req, res) => {
  const it = getItem(req.params.id);
  if (!it?.file) return res.status(404).end();
  res.sendFile(path.join(FILES_DIR, it.file), { headers: { 'Content-Type': 'application/pdf' } });
});
app.get('/api/items/:id/text', (req, res) => {
  const f = path.join(TEXT_DIR, `${req.params.id}.txt`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(f, 'utf8'));
});
// BibTeX export
app.get('/api/items/:id/bibtex', (req, res) => {
  const it = getItem(req.params.id);
  if (!it) return res.status(404).end();
  res.type('text/plain; charset=utf-8').send(toBibtex(it));
});
function toBibtex(it) {
  const first = (it.authors[0] || 'anon').split(' ').pop().toLowerCase().replace(/[^a-z]/g, '');
  const word = (it.title.split(/\s+/).find(w => w.length > 3) || 'paper').toLowerCase().replace(/[^a-z]/g, '');
  const f = { title: `{${it.title}}`, author: it.authors.join(' and '), year: it.year, journal: it.venue, doi: it.doi, url: it.url, eprint: it.arxiv };
  if (it.arxiv) f.archivePrefix = 'arXiv';
  const body = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
  return `@article{${first}${it.year}${word},\n${body}\n}`;
}
// ---------- Ingest ----------
async function ingestBuffer(buf, { origName = '', folder = '', hint = {} } = {}) {
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const dup = db.prepare('SELECT id FROM items WHERE hash = ? AND deleted = 0').get(hash);
  if (dup) return { item: getItem(dup.id), duplicate: true };
  const id = uid(), file = `${id}.pdf`;
  fs.writeFileSync(path.join(FILES_DIR, file), buf);
  const t = now();
  const title = hint.title || origName.replace(/\.pdf$/i, '') || '未命名文献';
  db.prepare(`INSERT INTO items (id, title, file, orig_name, hash, arxiv, folder, created, updated, meta_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, title, file, origName, hash, hint.arxiv || '', folder ? vault.ensureFolder(folder) : '', t, t);
  broadcast({ type: 'items' });
  indexItem(id, hint).catch(e => console.error('index failed', id, e));
  return { item: getItem(id), duplicate: false };
}

// Extract text, guess + resolve metadata, parse references
async function indexItem(id, hint = {}) {
  const it = getItem(id);
  update('items', id, { meta_status: 'indexing' }, ['meta_status']);
  broadcast({ type: 'item', id });
  let ex;
  try { ex = await extractPdf(path.join(FILES_DIR, it.file), 80); }
  catch (e) {
    update('items', id, { meta_status: 'error' }, ['meta_status']);
    return broadcast({ type: 'item', id });
  }
  fs.writeFileSync(path.join(TEXT_DIR, `${id}.txt`), fullText(ex.pages));
  const guess = guessFromFirstPage(ex.pages, ex.info);
  const refs = parseReferences(ex.pages);
  db.prepare('UPDATE items SET num_pages = ?, refs = ? WHERE id = ?').run(ex.numPages, JSON.stringify(refs), id);
  let meta = null;
  try {
    meta = await resolvePaper({ arxiv: hint.arxiv || guess.arxiv, doi: guess.doi, title: hint.title || guess.title });
  } catch { /* offline */ }
  const patch = meta ? {
    title: meta.title, authors: meta.authors || [], year: meta.year || '', venue: meta.venue || '',
    abstract: meta.abstract || guess.abstract, doi: meta.doi || guess.doi, arxiv: meta.arxiv || guess.arxiv,
    url: meta.url || '', meta_status: 'ok',
  } : {
    title: guess.title || it.title, abstract: guess.abstract, doi: guess.doi, arxiv: guess.arxiv,
    url: guess.arxiv ? `https://arxiv.org/abs/${guess.arxiv}` : '', meta_status: 'guessed',
  };
  if (patch.title) patch.title = patch.title.replace(/\s+/g, ' ').trim();
  update('items', id, patch, ['title', 'authors', 'year', 'venue', 'abstract', 'doi', 'arxiv', 'url', 'meta_status']);
  broadcast({ type: 'item', id });
  broadcast({ type: 'items' });
  prefetchRefs(id);
}

// Resolve references one at a time in the background so hovering is instant later.
// Sequential on purpose: keeps the per-host queue short, so interactive lookups wait at most one slot.
const prefetchQueue = [];
let prefetching = false;
function prefetchRefs(itemId) {
  if (!prefetchQueue.includes(itemId)) prefetchQueue.push(itemId);
  if (prefetching) return;
  prefetching = true;
  (async () => {
    while (prefetchQueue.length) {
      const id = prefetchQueue.shift();
      for (const r of getItem(id)?.refs || []) {
        const cur = getItem(id)?.refs.find(x => x.n === r.n);
        if (!cur || cur.resolved) continue;
        await resolveRefOnce(id, cur, { background: true }).catch(() => {});
      }
    }
  })().finally(() => { prefetching = false; });
}

app.post('/api/upload', upload.array('files'), wrap(async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    try {
      const buf = fs.readFileSync(f.path);
      if (buf.subarray(0, 5).toString() !== '%PDF-') { out.push({ name: f.originalname, error: '不是 PDF 文件' }); continue; }
      // multer gives latin1 file names
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      out.push(await ingestBuffer(buf, { origName: name, folder: req.body.folder || '' }));
    } finally { fs.rmSync(f.path, { force: true }); }
  }
  res.json(out);
}));

// Import by arXiv id / DOI / URL / title
async function importPaper({ arxiv = '', pdfUrl = '', title = '', doi = '', url = '' }, fromItem = null, folder = null) {
  if (!arxiv && !pdfUrl && !title && !doi && url) return importWeb(url, folder);
  arxiv = (arxiv || '').replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  const m = (pdfUrl || '').match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/);
  if (!arxiv && m) arxiv = m[1];
  let meta = null;
  if (!arxiv && !pdfUrl) {
    meta = await resolvePaper({ title, doi });
    if (!meta) throw new Error('找不到这篇论文');
    arxiv = meta.arxiv || '';
    pdfUrl = meta.pdfUrl || '';
  }
  const dlUrl = arxiv ? `https://arxiv.org/pdf/${arxiv}` : pdfUrl;
  if (!dlUrl) throw new Error('没有找到可下载的开放获取 PDF');
  // A link that turns out not to be a PDF (e.g. a blog post) is clipped as an article instead
  let buf;
  try { buf = await downloadPdf(dlUrl); }
  catch (e) {
    if (/不是 PDF/.test(e.message) && /^https?:/.test(dlUrl)) return importWeb(dlUrl, folder);
    throw e;
  }
  // Papers imported from a citation land next to the paper that cited them
  const target = folder ?? fromItem?.folder ?? '';
  const { item } = await ingestBuffer(buf, { origName: `${arxiv || 'download'}.pdf`, folder: target, hint: { arxiv, title: meta?.title || title } });
  return item;
}
app.post('/api/import', wrap(async (req, res) => {
  let { query = '', folder = '', as = '' } = req.body;
  query = query.trim();
  const arxivM = query.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i);
  const doiM = query.match(/\b(10\.\d{4,9}\/\S+)/);
  const isUrl = /^https?:\/\//i.test(query);
  // A non-arXiv web link: clip it as an article unless it is clearly a PDF
  if (isUrl && !arxivM && as !== 'paper' && (as === 'web' || !/\.pdf($|\?)/i.test(query))) {
    return res.json(await importWeb(query, folder));
  }
  const spec = arxivM ? { arxiv: arxivM[1] } : doiM ? { doi: doiM[1] } : isUrl ? { pdfUrl: query } : { title: query };
  res.json(await importPaper(spec, null, folder));
}));

// ---------- Web / blog clipping ----------
async function importWeb(url, folder = '') {
  const art = await fetchArticle(url);
  if (art.isPdf) {
    const { item } = await ingestBuffer(art.buffer, { origName: url.split('/').pop() || 'download.pdf', folder: folder || '' });
    return item;
  }
  if (!art.markdown || art.markdown.length < 80) throw new Error('没能从该页面提取到正文，可能需要登录或是动态页面');
  const dup = db.prepare("SELECT id FROM items WHERE url = ? AND kind = 'web' AND deleted = 0").get(art.url);
  const t = now();
  if (dup) {
    update('items', dup.id, { content: art.markdown, title: art.title, abstract: art.abstract, meta_status: 'ok' }, ['content', 'title', 'abstract', 'meta_status']);
    broadcast({ type: 'items' });
    return getItem(dup.id);
  }
  const id = uid();
  db.prepare(`INSERT INTO items (id, kind, title, authors, year, venue, abstract, url, content, folder, meta_status, created, updated)
    VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`)
    .run(id, art.title, JSON.stringify(art.authors), art.year, art.venue, art.abstract, art.url, art.markdown, folder ? vault.ensureFolder(folder) : '', t, t);
  fs.writeFileSync(path.join(TEXT_DIR, `${id}.txt`), art.markdown);
  broadcast({ type: 'items' });
  return getItem(id);
}
app.post('/api/items/:id/refetch', wrap(async (req, res) => {
  const it = getItem(req.params.id);
  if (it?.kind !== 'web') throw notFound();
  res.json(await importWeb(it.url, it.folder));
}));

app.post('/api/items/:id/reindex', wrap(async (req, res) => {
  const it = getItem(req.params.id);
  if (!it) throw notFound();
  await indexItem(it.id, { arxiv: req.body.arxiv, title: req.body.title });
  res.json(getItem(it.id));
}));

// Concurrent requests for the same reference share one lookup
const refJobs = new Map();
function resolveRefOnce(itemId, ref, { background = false } = {}) {
  const key = `${itemId}:${ref.n}`;
  if (!refJobs.has(key)) {
    refJobs.set(key, (async () => {
      const title = titleFromReference(ref.raw);
      let meta = null, transient = false;
      try { meta = await resolvePaper({ arxiv: ref.arxiv, title }, { background }); } catch (e) { transient ||= !!e.transient; }
      if (!meta && !transient) { try { meta = await resolvePaper({ raw: ref.raw }, { background }); } catch (e) { transient ||= !!e.transient; } }
      // Network trouble: keep it unresolved so it's retried, but tell the caller
      if (!meta && transient) return { ...ref, title, error: '在线数据源暂时不可用，稍后重试' };
      const out = { ...ref, resolved: true, resolvedAt: Date.now(), bg: background && !meta, meta, title: meta?.title || title };
      // Re-read inside the sync section so parallel lookups don't clobber each other
      const cur = getItem(itemId);
      if (cur) db.prepare('UPDATE items SET refs = ? WHERE id = ?').run(JSON.stringify(cur.refs.map(r => r.n === ref.n ? out : r)), itemId);
      return out;
    })().finally(() => refJobs.delete(key)));
  }
  return refJobs.get(key);
}

// Resolve a cited reference (lazy, cached into item.refs)
app.get('/api/items/:id/refs/:n', wrap(async (req, res) => {
  const it = getItem(req.params.id);
  if (!it) throw notFound();
  const n = +req.params.n;
  let ref = it.refs.find(r => r.n === n);
  if (!ref) return res.json(null);
  // Re-resolve if never resolved, or a previous attempt found nothing more than 10 min ago (network may be back)
  // Background misses get one interactive retry (which also tries the slower sources); later misses re-try after 10 min
  const stale = ref.resolved && !ref.meta && (ref.bg || Date.now() - (ref.resolvedAt || 0) > 10 * 60 * 1000);
  // ?local=1 → answer instantly from the parsed reference list (the UI shows this while the online lookup runs)
  if (!req.query.local && (!ref.resolved || stale || req.query.retry)) {
    // Cap the wait; the lookup keeps running and is cached for the next request
    const job = resolveRefOnce(it.id, ref);
    const r = await Promise.race([job, new Promise(r => setTimeout(() => r(null), 25000))]);
    ref = r || { ...ref, pending: true };
  }
  // Is it already in the library?
  const t = ref.meta?.title || ref.title;
  const local = t ? db.prepare('SELECT id, title FROM items WHERE deleted = 0 AND (lower(title) = lower(?) OR (arxiv != \'\' AND arxiv = ?))').get(t, ref.meta?.arxiv || ref.arxiv || '-') : null;
  res.json({ ...ref, localId: local?.id || null });
}));
app.post('/api/items/:id/refs/:n/import', wrap(async (req, res) => {
  const it = getItem(req.params.id);
  const ref = it?.refs.find(r => r.n === +req.params.n);
  if (!ref) throw notFound();
  const m = ref.meta || {};
  res.json(await importPaper({ arxiv: m.arxiv || ref.arxiv, pdfUrl: m.pdfUrl, title: m.title || ref.title || titleFromReference(ref.raw), doi: m.doi }, it));
}));
// Resolve a free-form reference string (used when the PDF's reference list couldn't be parsed)
app.post('/api/resolve', wrap(async (req, res) => {
  const raw = String(req.body.raw || '').slice(0, 600);
  const title = titleFromReference(raw);
  let meta = null;
  try { meta = await resolvePaper({ title }); } catch {}
  if (!meta) { try { meta = await resolvePaper({ raw }); } catch {} }
  const t = meta?.title || title;
  const local = t ? db.prepare('SELECT id FROM items WHERE deleted = 0 AND lower(title) = lower(?)').get(t) : null;
  res.json({ raw, title: t, meta, localId: local?.id || null });
}));

// ---------- Annotations ----------
const getAnn = id => decode(db.prepare('SELECT * FROM annotations WHERE id = ?').get(id));
app.get('/api/items/:id/annotations', (req, res) => {
  res.json(db.prepare('SELECT * FROM annotations WHERE item_id = ? ORDER BY page, created').all(req.params.id).map(decode)
    .map(a => ({ ...a, ai_status: a.ai_status === 'running' && !isRunning(a.id) ? 'error' : a.ai_status })));
});
app.post('/api/items/:id/annotations', (req, res) => {
  const b = req.body, t = now(), id = uid();
  db.prepare(`INSERT INTO annotations (id, item_id, page, color, text, comment, rects, ref_index, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.params.id, b.page | 0, b.color || 'yellow', b.text || '',
    b.comment || '', JSON.stringify(b.rects || []), b.ref_index ?? null, t, t);
  const a = getAnn(id);
  broadcast({ type: 'annotation', annotation: a });
  res.json(a);
});
app.patch('/api/annotations/:id', (req, res) => {
  if (!getAnn(req.params.id)) return res.status(404).json({ error: '批注已删除' });
  update('annotations', req.params.id, req.body, ['color', 'comment', 'text', 'ai_reply', 'ai_status']);
  const a = getAnn(req.params.id);
  broadcast({ type: 'annotation', annotation: a });
  res.json(a);
});
app.delete('/api/annotations/:id', (req, res) => {
  const a = getAnn(req.params.id);
  if (isRunning(req.params.id)) cancelTask(req.params.id);
  db.prepare('DELETE FROM annotations WHERE id = ?').run(req.params.id);
  if (a) broadcast({ type: 'annotation-deleted', id: a.id, item_id: a.item_id });
  res.json({ ok: true });
});
app.post('/api/annotations/:id/ai', wrap(async (req, res) => {
  if (!getAnn(req.params.id)) throw notFound();
  runTask(req.params.id, { importer: (spec, fromItem) => importPaper(spec, fromItem), instruction: req.body?.instruction || '' });
  res.json(getAnn(req.params.id));
}));
app.post('/api/annotations/:id/ai/cancel', (req, res) => { cancelTask(req.params.id); res.json(getAnn(req.params.id)); });

// ---------- Notes (.md files in the vault) ----------
// A note's id is its vault-relative path, e.g. "具身推理/ReAct …/读后笔记.md"
const noteOut = n => ({ ...n, item_id: n.itemId ?? null, updated: n.mtime, item: n.itemId ? db.prepare('SELECT id, title FROM items WHERE id = ?').get(n.itemId) || null : null });
app.get('/api/notes', (req, res) => {
  const { item, folder, q } = req.query;
  let list = q ? vault.searchNotes(q) : vault.scan().notes;
  if (item) list = list.filter(n => n.itemId === item);
  else {
    list = list.filter(n => !n.itemId);            // standalone notes only
    if (folder) list = list.filter(n => n.dir === folder || n.dir.startsWith(folder + '/'));
    if (req.query.view === 'unfiled') list = list.filter(n => n.dir === '');
  }
  res.json(list.sort((a, b) => b.mtime - a.mtime).map(noteOut));
});
app.get('/api/note', wrap(async (req, res) => res.json(noteOut(vault.readNote(String(req.query.id || ''))))));
// Create: {item_id} → inside that paper's folder; otherwise {folder}
app.post('/api/notes', wrap(async (req, res) => {
  const { item_id, folder = '', title, content = '' } = req.body;
  let dir = folder;
  if (item_id) {
    const it = getItem(item_id);
    if (!it) throw notFound();
    dir = vault.ensurePaperDir(it);
  }
  const name = title || deriveTitle(content) || (item_id ? '笔记' : '未命名笔记');
  const id = vault.createNote(dir, name, content);
  const n = noteOut(vault.readNote(id));
  broadcast({ type: 'note', note: n }); broadcast({ type: 'tree' });
  res.json(n);
}));
// Save content; the file is renamed when the first heading changes (unless the user renamed it manually)
app.put('/api/note', wrap(async (req, res) => {
  let id = String(req.query.id || '');
  const { content, title } = req.body;
  if (typeof content === 'string') vault.writeNote(id, content);
  const want = title ?? (req.body.autoTitle ? deriveTitle(content) : null);
  let renamed = false;
  if (want) {
    const cur = id.split('/').pop().replace(/\.md$/i, '');
    if (vault.safeName(want) !== cur) { id = vault.moveNote(id, { title: want }); renamed = true; }
  }
  const n = noteOut(vault.readNote(id));
  broadcast({ type: 'note', note: n, origin: req.get('x-client-id') || '', renamedFrom: renamed ? String(req.query.id) : undefined });
  if (renamed) broadcast({ type: 'tree' });
  res.json(n);
}));
app.delete('/api/note', wrap(async (req, res) => {
  const id = String(req.query.id || '');
  let itemId = null;
  try { itemId = vault.readNote(id).itemId; } catch { /* already gone */ }
  vault.trashPath(id);
  broadcast({ type: 'note-deleted', id, item_id: itemId }); broadcast({ type: 'tree' });
  res.json({ ok: true });
}));
function deriveTitle(content = '') {
  const line = content.split('\n').find(l => l.trim()) || '';
  return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 80);
}

// ---------- Settings ----------
const SECRET_KEYS = ['llmApiKey', 'openalexKey'];
const maskKey = s => { const o = { ...s }; for (const k of SECRET_KEYS) o[k] = s[k] ? '••••' + s[k].slice(-4) : ''; return o; };
app.get('/api/settings', (req, res) => res.json(maskKey(getSettings())));
app.put('/api/settings', (req, res) => {
  const patch = { ...req.body };
  for (const k of SECRET_KEYS) if (typeof patch[k] === 'string' && patch[k].startsWith('••••')) delete patch[k];
  const prevVault = getSettings().vaultDir;
  setSettings(patch);
  configureSources(getSettings());
  // Switching vaults (e.g. to an existing Obsidian vault): papers keep their DB rows and
  // fall back to the root until their folders exist in the new vault
  if (patch.vaultDir && patch.vaultDir !== prevVault) { vault.openVault(getSettings().vaultDir); broadcast({ type: 'tree' }); broadcast({ type: 'items' }); }
  res.json(maskKey(getSettings()));
});
app.get('/api/sources', (req, res) => res.json(sourceStatus()));

// ---------- LLM features (streamed plain text) ----------
async function streamLLM(res, opts) {
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    await chat({ ...opts, signal: ac.signal, onDelta: t => res.write(t) });
  } catch (e) {
    if (!ac.signal.aborted) res.write(`\n\n⚠️ ${e.message}`);
  }
  res.end();
}
const paperText = (id, max = 120000) => {
  const f = path.join(TEXT_DIR, `${id}.txt`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, max) : '';
};

app.post('/api/translate', (req, res) => {
  const { text, context = '', mode = 'translate' } = req.body;
  const lang = getSettings().targetLang || '简体中文';
  const system = mode === 'explain'
    ? `你是 AI/机器学习领域的论文阅读助手。用${lang}解释用户选中的论文片段：说明含义、涉及的概念/公式符号、以及在上下文中的作用。简洁，Markdown 格式，公式用 $...$。`
    : `你是专业的学术翻译。把用户给出的论文片段翻译成${lang}。要求：术语准确（如 transformer、token、embedding 等通用术语首次出现可保留英文括注），公式/符号/引用编号原样保留，只输出译文。PDF 换行与连字符造成的断词需自动修复。`;
  streamLLM(res, { system, messages: [{ role: 'user', content: context ? `上下文（论文：${context}）\n\n片段：\n${text}` : text }], maxTokens: 2048 });
});

app.post('/api/items/:id/chat', (req, res) => {
  const it = getItem(req.params.id);
  if (!it) return res.status(404).end();
  const system = `你是论文阅读助手。下面是用户正在阅读的论文全文（PDF 抽取文本，可能有排版噪声）。基于论文内容用中文回答问题，引用原文时注明页码（如 p.3）。不确定的地方明确说明。Markdown 输出，公式用 $...$。

论文：${it.title}
作者：${it.authors.join(', ')}
${paperText(it.id)}`;
  streamLLM(res, { system, messages: (req.body.messages || []).slice(-20) });
});

// ---------- Static / Vite ----------
app.use('/pdfjs', express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist'), { maxAge: '7d' }));
const isProd = process.env.NODE_ENV === 'production' || !!process.env.PAPER_EMBEDDED;
if (isProd) {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: path.join(ROOT, 'client'), configFile: path.join(ROOT, 'vite.config.js'), server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

configureSources(getSettings());

// ---------- Auto-update (desktop build only; the Electron shell installs a controller) ----------
let updateCtl = null;
export function setUpdateController(ctl) {
  updateCtl = ctl;
  ctl.subscribe?.(s => broadcast({ type: 'update', state: s }));
}
const noUpdater = { status: 'unsupported', version: '', reason: '浏览器模式（npm run dev）不支持自动更新，请用 git pull 更新' };
app.get('/api/update', (req, res) => res.json(updateCtl ? updateCtl.state() : noUpdater));
app.post('/api/update/check', wrap(async (req, res) => { if (!updateCtl) return res.json(noUpdater); await updateCtl.check(); res.json(updateCtl.state()); }));
app.post('/api/update/install', (req, res) => res.json(updateCtl ? updateCtl.install() : { ok: false, reason: noUpdater.reason }));

// ---------- Vault ----------
vault.openVault(getSettings().vaultDir);
// Changes made outside the app (Obsidian, Explorer, sync tools): refresh the tree and push new
// content of any open .md so editors update in place
vault.setVaultChangeHandler(({ external, files }) => {
  if (!external) return;
  broadcast({ type: 'tree' }); broadcast({ type: 'items' });
  for (const f of files) {
    if (!/\.md$/i.test(f)) continue;
    try { broadcast({ type: 'note', note: noteOut(vault.readNote(f)), origin: 'external' }); } catch { /* deleted or moved */ }
  }
});
migrateToVault();

// One-time move of the old DB-based categories and notes into real folders / .md files.
// The old tables are kept (renamed) as a backup rather than dropped.
function migrateToVault() {
  const has = t => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has('collections') || has('_old_collections')) return;
  const colls = db.prepare('SELECT * FROM collections').all();
  const byId = new Map(colls.map(c => [c.id, c]));
  const pathOf = new Map();
  const resolve = c => {
    if (pathOf.has(c.id)) return pathOf.get(c.id);
    const parent = c.parent_id && byId.get(c.parent_id) ? resolve(byId.get(c.parent_id)) : '';
    const p = (parent ? parent + '/' : '') + vault.safeName(c.name, '分类');
    pathOf.set(c.id, p);
    return p;
  };
  for (const c of colls) vault.ensureFolder(resolve(c));
  // A paper in several categories goes to the first one (folders can only hold it once)
  for (const r of db.prepare('SELECT item_id, MIN(collection_id) cid FROM item_collections GROUP BY item_id').all()) {
    const p = pathOf.get(r.cid);
    if (p) db.prepare('UPDATE items SET folder = ? WHERE id = ?').run(p, r.item_id);
  }
  let moved = 0;
  if (has('notes')) {
    for (const n of db.prepare('SELECT * FROM notes').all()) {
      let dir = '';
      if (n.item_id) { const it = getItem(n.item_id); if (!it) continue; dir = vault.ensurePaperDir(it); }
      else {
        const nc = has('note_collections') && db.prepare('SELECT collection_id FROM note_collections WHERE note_id = ? LIMIT 1').get(n.id);
        dir = (nc && pathOf.get(nc.collection_id)) || '';
      }
      vault.createNote(dir, n.title || deriveTitle(n.content) || '未命名笔记', n.content || '');
      moved++;
    }
  }
  db.exec(`ALTER TABLE collections RENAME TO _old_collections;
    ALTER TABLE item_collections RENAME TO _old_item_collections;
    ${has('notes') ? 'ALTER TABLE notes RENAME TO _old_notes;' : ''}
    ${has('note_collections') ? 'ALTER TABLE note_collections RENAME TO _old_note_collections;' : ''}`);
  console.log(`vault migration: ${colls.length} folders, ${moved} notes → ${vault.getVaultDir()}`);
}
app.post('/api/vault/open', (req, res) => {
  // Opens the vault folder in the OS file manager (desktop convenience)
  import('node:child_process').then(({ spawn }) => {
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [vault.getVaultDir()], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  });
  res.json({ ok: true, path: vault.getVaultDir() });
});

// Clean up stale "running" states from a previous crash
db.prepare("UPDATE annotations SET ai_status = 'error', ai_log = ai_log || '\n(服务重启，任务中断)' WHERE ai_status = 'running'").run();
db.prepare("UPDATE items SET meta_status = 'pending' WHERE meta_status = 'indexing'").run();
for (const r of db.prepare("SELECT id FROM items WHERE meta_status = 'pending' AND deleted = 0").all()) indexItem(r.id).catch(() => {});
// Finish prefetching references left unresolved by a previous run
for (const r of db.prepare("SELECT id, refs FROM items WHERE deleted = 0 AND meta_status != 'pending'").all()) {
  if (r.refs.includes('"raw"') && JSON.parse(r.refs).some(x => !x.resolved)) prefetchRefs(r.id);
}

// A stray rejection (e.g. a network error in a background task) must not take the server down
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
process.on('uncaughtException', e => console.error('uncaughtException', e));

// Port 0 = let the OS pick a free one (used by the desktop build)
export function startServer(port = +process.env.PORT || 5178) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1');
    srv.on('listening', () => {
      const url = `http://127.0.0.1:${srv.address().port}`;
      console.log(`Paper Reader → ${url}`);
      resolve({ server: srv, url });
    });
    srv.on('error', e => {
      // Desktop build: fall back to a random free port if the default is taken
      if (e.code === 'EADDRINUSE' && port !== 0 && process.env.PAPER_ANY_PORT) startServer(0).then(resolve, reject);
      else reject(e);
    });
  });
}

// Started directly (npm run dev / npm start) → listen immediately
if (!process.env.PAPER_EMBEDDED) startServer();
