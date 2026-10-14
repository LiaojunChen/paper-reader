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

// ---------- Collections ----------
app.get('/api/collections', (req, res) => res.json(db.prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE').all()));
app.post('/api/collections', (req, res) => {
  const c = { id: uid(), name: (req.body.name || '新建分类').slice(0, 200), parent_id: req.body.parent_id || null, created: now() };
  db.prepare('INSERT INTO collections (id, name, parent_id, created) VALUES (?, ?, ?, ?)').run(c.id, c.name, c.parent_id, c.created);
  res.json(c);
});
app.patch('/api/collections/:id', (req, res) => {
  if (req.body.parent_id === req.params.id) return res.status(400).json({ error: '不能把分类移到自身下' });
  update('collections', req.params.id, req.body, ['name', 'parent_id']);
  res.json(db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id));
});
app.delete('/api/collections/:id', (req, res) => {
  db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/collections/:id/items', (req, res) => {
  const st = db.prepare('INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?, ?)');
  for (const id of req.body.itemIds || []) st.run(id, req.params.id);
  for (const id of req.body.noteIds || []) db.prepare('INSERT OR IGNORE INTO note_collections (note_id, collection_id) VALUES (?, ?)').run(id, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/collections/:id/items/:itemId', (req, res) => {
  db.prepare('DELETE FROM item_collections WHERE collection_id = ? AND item_id = ?').run(req.params.id, req.params.itemId);
  db.prepare('DELETE FROM note_collections WHERE collection_id = ? AND note_id = ?').run(req.params.id, req.params.itemId);
  res.json({ ok: true });
});

// ---------- Items ----------
const LIST_COLS = `i.id, i.title, i.authors, i.year, i.venue, i.doi, i.arxiv, i.url, i.file, i.tags, i.meta_status, i.kind,
  i.starred, i.deleted, i.created, i.updated, i.last_page, i.num_pages,
  (SELECT COUNT(*) FROM annotations a WHERE a.item_id = i.id) AS ann_count,
  (SELECT COUNT(*) FROM notes n WHERE n.item_id = i.id) AS note_count,
  (SELECT GROUP_CONCAT(collection_id) FROM item_collections ic WHERE ic.item_id = i.id) AS collection_ids`;

app.get('/api/items', (req, res) => {
  const { collection, q, view } = req.query;
  const where = [], args = [];
  if (view === 'trash') where.push('i.deleted = 1'); else where.push('i.deleted = 0');
  if (view === 'starred') where.push('i.starred = 1');
  if (view === 'unfiled') where.push('NOT EXISTS (SELECT 1 FROM item_collections ic WHERE ic.item_id = i.id)');
  if (collection) {
    // include sub-collections
    const ids = descendants(collection);
    where.push(`EXISTS (SELECT 1 FROM item_collections ic WHERE ic.item_id = i.id AND ic.collection_id IN (${ids.map(() => '?').join(',')}))`);
    args.push(...ids);
  }
  if (q) {
    where.push(`(i.title LIKE ? OR i.authors LIKE ? OR i.tags LIKE ? OR i.abstract LIKE ? OR i.venue LIKE ?
      OR EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = i.id AND (a.text LIKE ? OR a.comment LIKE ?))
      OR EXISTS (SELECT 1 FROM notes n WHERE n.item_id = i.id AND n.content LIKE ?))`);
    args.push(...Array(8).fill(`%${q}%`));
  }
  const rows = db.prepare(`SELECT ${LIST_COLS} FROM items i WHERE ${where.join(' AND ')} ORDER BY i.created DESC`).all(...args);
  res.json(rows.map(r => ({ ...decode(r), collection_ids: r.collection_ids ? r.collection_ids.split(',') : [] })));
});

function descendants(id) {
  const all = db.prepare('SELECT id, parent_id FROM collections').all();
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of all) if (c.parent_id === out[i]) out.push(c.id);
  return out;
}

const getItem = id => decode(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
app.get('/api/items/:id', (req, res) => {
  const it = getItem(req.params.id);
  if (!it) return res.status(404).json({ error: '未找到' });
  it.collection_ids = db.prepare('SELECT collection_id FROM item_collections WHERE item_id = ?').all(it.id).map(r => r.collection_id);
  res.json(it);
});
app.patch('/api/items/:id', (req, res) => {
  update('items', req.params.id, req.body, ['title', 'authors', 'year', 'venue', 'abstract', 'doi', 'arxiv', 'url', 'tags', 'starred', 'deleted', 'last_page', 'content']);
  const it = getItem(req.params.id);
  if (Object.keys(req.body).some(k => k !== 'last_page')) broadcast({ type: 'items' });
  res.json(it);
});
app.delete('/api/items/:id', (req, res) => {
  const it = getItem(req.params.id);
  if (!it) return res.json({ ok: true });
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
async function ingestBuffer(buf, { origName = '', collectionId = null, hint = {} } = {}) {
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const dup = db.prepare('SELECT id FROM items WHERE hash = ? AND deleted = 0').get(hash);
  if (dup) return { item: getItem(dup.id), duplicate: true };
  const id = uid(), file = `${id}.pdf`;
  fs.writeFileSync(path.join(FILES_DIR, file), buf);
  const t = now();
  const title = hint.title || origName.replace(/\.pdf$/i, '') || '未命名文献';
  db.prepare(`INSERT INTO items (id, title, file, orig_name, hash, arxiv, created, updated, meta_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, title, file, origName, hash, hint.arxiv || '', t, t);
  if (collectionId) db.prepare('INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?, ?)').run(id, collectionId);
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
      out.push(await ingestBuffer(buf, { origName: name, collectionId: req.body.collectionId || null }));
    } finally { fs.rmSync(f.path, { force: true }); }
  }
  res.json(out);
}));

// Import by arXiv id / DOI / URL / title
async function importPaper({ arxiv = '', pdfUrl = '', title = '', doi = '', url = '' }, fromItem = null, collectionId = null) {
  if (!arxiv && !pdfUrl && !title && !doi && url) return importWeb(url, collectionId);
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
    if (/不是 PDF/.test(e.message) && /^https?:/.test(dlUrl)) return importWeb(dlUrl, collectionId);
    throw e;
  }
  // Place into same collections as the source paper by default
  const coll = collectionId || (fromItem && db.prepare('SELECT collection_id FROM item_collections WHERE item_id = ? LIMIT 1').get(fromItem.id)?.collection_id) || null;
  const { item } = await ingestBuffer(buf, { origName: `${arxiv || 'download'}.pdf`, collectionId: coll, hint: { arxiv, title: meta?.title || title } });
  return item;
}
app.post('/api/import', wrap(async (req, res) => {
  let { query = '', collectionId = null, as = '' } = req.body;
  query = query.trim();
  const arxivM = query.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i);
  const doiM = query.match(/\b(10\.\d{4,9}\/\S+)/);
  const isUrl = /^https?:\/\//i.test(query);
  // A non-arXiv web link: clip it as an article unless it is clearly a PDF
  if (isUrl && !arxivM && as !== 'paper' && (as === 'web' || !/\.pdf($|\?)/i.test(query))) {
    return res.json(await importWeb(query, collectionId));
  }
  const spec = arxivM ? { arxiv: arxivM[1] } : doiM ? { doi: doiM[1] } : isUrl ? { pdfUrl: query } : { title: query };
  res.json(await importPaper(spec, null, collectionId));
}));

// ---------- Web / blog clipping ----------
async function importWeb(url, collectionId = null) {
  const art = await fetchArticle(url);
  if (art.isPdf) {
    const { item } = await ingestBuffer(art.buffer, { origName: url.split('/').pop() || 'download.pdf', collectionId });
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
  db.prepare(`INSERT INTO items (id, kind, title, authors, year, venue, abstract, url, content, meta_status, created, updated)
    VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`)
    .run(id, art.title, JSON.stringify(art.authors), art.year, art.venue, art.abstract, art.url, art.markdown, t, t);
  if (collectionId) db.prepare('INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?, ?)').run(id, collectionId);
  fs.writeFileSync(path.join(TEXT_DIR, `${id}.txt`), art.markdown);
  broadcast({ type: 'items' });
  return getItem(id);
}
app.post('/api/items/:id/refetch', wrap(async (req, res) => {
  const it = getItem(req.params.id);
  if (it?.kind !== 'web') throw notFound();
  res.json(await importWeb(it.url));
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

// ---------- Notes ----------
const getNote = id => db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
app.get('/api/notes', (req, res) => {
  const { item, collection, q } = req.query;
  if (item) return res.json(db.prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY updated DESC').all(item));
  const where = ['n.item_id IS NULL'], args = [];
  if (collection) {
    const ids = descendants(collection);
    where.push(`EXISTS (SELECT 1 FROM note_collections nc WHERE nc.note_id = n.id AND nc.collection_id IN (${ids.map(() => '?').join(',')}))`);
    args.push(...ids);
  }
  if (q) { where.push('(n.title LIKE ? OR n.content LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  res.json(db.prepare(`SELECT n.*, (SELECT GROUP_CONCAT(collection_id) FROM note_collections nc WHERE nc.note_id = n.id) AS collection_ids
    FROM notes n WHERE ${where.join(' AND ')} ORDER BY n.updated DESC`).all(...args)
    .map(r => ({ ...r, collection_ids: r.collection_ids ? r.collection_ids.split(',') : [] })));
});
app.get('/api/notes/:id', (req, res) => {
  const n = getNote(req.params.id);
  if (!n) return res.status(404).json({ error: '未找到' });
  res.json({ ...n, item: n.item_id ? db.prepare('SELECT id, title FROM items WHERE id = ?').get(n.item_id) : null });
});
app.post('/api/notes', (req, res) => {
  const t = now(), id = uid();
  db.prepare('INSERT INTO notes (id, item_id, title, content, created, updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.body.item_id || null, req.body.title || '', req.body.content || '', t, t);
  if (req.body.collectionId) db.prepare('INSERT OR IGNORE INTO note_collections (note_id, collection_id) VALUES (?, ?)').run(id, req.body.collectionId);
  const n = getNote(id);
  broadcast({ type: 'note', note: n });
  res.json(n);
});
app.patch('/api/notes/:id', (req, res) => {
  update('notes', req.params.id, req.body, ['title', 'content']);
  const n = getNote(req.params.id);
  broadcast({ type: 'note', note: n, origin: req.get('x-client-id') || '' });
  res.json(n);
});
app.delete('/api/notes/:id', (req, res) => {
  const n = getNote(req.params.id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  if (n) broadcast({ type: 'note-deleted', id: n.id, item_id: n.item_id });
  res.json({ ok: true });
});

// ---------- Settings ----------
const SECRET_KEYS = ['llmApiKey', 'openalexKey'];
const maskKey = s => { const o = { ...s }; for (const k of SECRET_KEYS) o[k] = s[k] ? '••••' + s[k].slice(-4) : ''; return o; };
app.get('/api/settings', (req, res) => res.json(maskKey(getSettings())));
app.put('/api/settings', (req, res) => {
  const patch = { ...req.body };
  for (const k of SECRET_KEYS) if (typeof patch[k] === 'string' && patch[k].startsWith('••••')) delete patch[k];
  setSettings(patch);
  configureSources(getSettings());
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
