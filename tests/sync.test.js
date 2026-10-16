import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SyncStore, safePath } from '../server/sync-store.js';
import { capture, contextOf, edit, mergeMaps, materialize, preserveFileConflicts, hash, validateManifest, FORMAT } from '../server/sync-model.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), ITEM = '1'.repeat(16), ANN = '2'.repeat(16);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-sync-'));
  const databases = [];
  t.after(() => { databases.forEach(db => db.close()); fs.rmSync(root, { recursive: true, force: true }); });
  let number = 0;
  const make = () => {
    const dataDir = path.join(root, String(++number)), filesDir = path.join(dataDir, 'files'), textDir = path.join(dataDir, 'text'), vault = path.join(dataDir, 'vault');
    for (const dir of [filesDir, textDir, vault]) fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'library.db')); databases.push(db);
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', file TEXT DEFAULT '', folder TEXT DEFAULT '', last_page INTEGER DEFAULT 1, starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, meta_status TEXT DEFAULT 'pending');
      CREATE TABLE annotations (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, comment TEXT DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
    const store = new SyncStore({ db, dataDir, filesDir, textDir, vaultDir: () => vault });
    return { store, db, dataDir, filesDir, textDir, vault,
      note: (name, content) => { const file = path.join(vault, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); },
      item: () => db.prepare('SELECT * FROM items WHERE id=?').get(ITEM),
      add: () => { db.prepare('INSERT INTO items(id,title,file,created,updated) VALUES (?,?,?,?,?)').run(ITEM, 'Original', `${ITEM}.pdf`, 1, 1); fs.writeFileSync(path.join(filesDir, `${ITEM}.pdf`), 'PDF bytes'); },
    };
  };
  const entries = new Map(); let serial = 0, failUpload = false, beforeDownload;
  const drive = {
    auth: () => ({ binding: 'account-one' }),
    list: async () => structuredClone([...entries.values()].map(({ body, ...entry }) => entry)),
    readManifest: async id => JSON.parse(entries.get(id).body.toString()),
    download: async (id, file, expected) => { if (beforeDownload) { const fn = beforeDownload; beforeDownload = null; await fn(); } const body = entries.get(id).body; assert.equal(hash(body), expected); fs.writeFileSync(file, body); },
    uploadFile: async (file, digest) => drive.upload(`blob-${digest}`, fs.readFileSync(file), 'blob', { hash: digest }),
    upload: async (name, body, role, extra = {}, id = '') => { if (failUpload) { failUpload = false; throw new Error('offline'); } id ||= String(++serial); const entry = { id, name, appProperties: { role, ...extra }, body: Buffer.from(body) }; entries.set(id, entry); return { id, name, appProperties: entry.appProperties }; },
  };
  return { make, drive, entries, fail: () => { failUpload = true; }, duringDownload: fn => { beforeDownload = fn; } };
}

test('registers converge in any order, and a causal edit resolves siblings', () => {
  const a = {}, b = {}, c = {};
  edit(a, 'item/x/title', 'A', A, {}); edit(b, 'item/x/title', 'B', B, {}); edit(c, 'item/x/title', 'C', C, {});
  const merged = mergeMaps(a, b, c);
  assert.deepEqual(merged, mergeMaps(c, a, b));
  assert.deepEqual(merged, mergeMaps(mergeMaps(b, c), a));
  assert.equal(materialize(merged)['item/x/title'], 'C');
  edit(merged, 'item/x/title', 'resolved', A, contextOf(merged));
  assert.equal(mergeMaps(merged, b, c)['item/x/title'].versions.length, 1);
});

test('notes keep both offline edits, and deleted conflict copies stay deleted', () => {
  const a = {}, b = {};
  edit(a, 'vault/n.md', { hash: 'a', size: 1 }, A, {}); edit(b, 'vault/n.md', { hash: 'b', size: 1 }, B, {});
  const merged = mergeMaps(a, b); preserveFileConflicts(merged);
  const conflict = Object.keys(merged).find(k => k.includes('冲突'));
  assert.ok(conflict);
  edit(merged, conflict, null, A, contextOf(merged)); preserveFileConflicts(merged);
  assert.equal(materialize(merged)[conflict], undefined);
});

test('two devices transfer PDFs, annotations, notes, folders and page progress; secrets stay local', async t => {
  const { make, drive } = fixture(t), a = make(), b = make();
  a.add(); a.note('Research/笔记.md', '# First\nnotes'); fs.mkdirSync(path.join(a.vault, 'Empty'));
  a.db.prepare('INSERT INTO annotations VALUES(?,?,?,?,?)').run(ANN, ITEM, 'comment', 1, 1);
  a.db.prepare('INSERT INTO settings VALUES(?,?)').run('llmApiKey', 'private-api-key');
  await a.store.sync(drive); await b.store.sync(drive);
  assert.equal(b.item().title, 'Original');
  assert.equal(fs.readFileSync(path.join(b.filesDir, `${ITEM}.pdf`), 'utf8'), 'PDF bytes');
  assert.equal(fs.readFileSync(path.join(b.vault, 'Research/笔记.md'), 'utf8'), '# First\nnotes');
  assert.ok(fs.existsSync(path.join(b.vault, 'Empty')));
  assert.equal(b.db.prepare('SELECT comment FROM annotations').get().comment, 'comment');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM settings').get().n, 0);
  a.db.prepare('UPDATE items SET title=? WHERE id=?').run('New title', ITEM);
  b.db.prepare('UPDATE items SET last_page=12 WHERE id=?').run(ITEM);
  await a.store.sync(drive); await b.store.sync(drive); await a.store.sync(drive);
  assert.equal(a.item().title, 'New title'); assert.equal(a.item().last_page, 12);
  assert.equal(b.item().title, 'New title');
  assert.ok(!JSON.stringify(a.store.state.records).includes('private-api-key'));
});

test('offline note conflicts produce the same copies on both devices', async t => {
  const { make, drive } = fixture(t), a = make(), b = make();
  a.note('n.md', 'base'); await a.store.sync(drive); await b.store.sync(drive);
  a.note('n.md', 'edit A'); b.note('n.md', 'edit B');
  await a.store.sync(drive); await b.store.sync(drive); await a.store.sync(drive);
  const contents = device => fs.readdirSync(device.vault).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(device.vault, f), 'utf8')).sort();
  assert.deepEqual(contents(a), ['edit A', 'edit B']); assert.deepEqual(contents(a), contents(b));
  assert.deepEqual(a.store.state.records, b.store.state.records);
});

test('deletions propagate without resurrecting old notes or items', async t => {
  const { make, drive } = fixture(t), a = make(), b = make();
  a.add(); a.note('n.md', 'base'); await a.store.sync(drive); await b.store.sync(drive);
  fs.unlinkSync(path.join(a.vault, 'n.md')); a.db.prepare('DELETE FROM items').run(); fs.unlinkSync(path.join(a.filesDir, `${ITEM}.pdf`));
  b.db.prepare('UPDATE items SET title=? WHERE id=?').run('Offline edit', ITEM);
  await a.store.sync(drive); await b.store.sync(drive); await a.store.sync(drive);
  assert.equal(b.item(), undefined); assert.equal(fs.existsSync(path.join(b.vault, 'n.md')), false);
  assert.equal(fs.existsSync(path.join(b.filesDir, `${ITEM}.pdf`)), false);
  assert.ok(fs.readdirSync(path.join(b.dataDir, 'sync/backups')).length);
});

test('edits during download are re-captured and preserved', async t => {
  const { make, drive, duringDownload } = fixture(t), a = make(), b = make();
  a.note('n.md', 'base'); await a.store.sync(drive); await b.store.sync(drive);
  a.note('n.md', 'remote edit'); await a.store.sync(drive);
  duringDownload(() => b.note('n.md', 'local edit during pull'));
  await b.store.sync(drive);
  const texts = fs.readdirSync(b.vault).map(f => fs.readFileSync(path.join(b.vault, f), 'utf8'));
  assert.ok(texts.includes('remote edit')); assert.ok(texts.includes('local edit during pull'));
});

test('upload failure can be retried and a new account receives no old tombstones', async t => {
  const { make, drive, fail } = fixture(t), a = make(), b = make();
  a.note('n.md', 'offline'); fail(); await assert.rejects(a.store.sync(drive), /offline/);
  await a.store.sync(drive); await b.store.sync(drive);
  assert.equal(fs.readFileSync(path.join(b.vault, 'n.md'), 'utf8'), 'offline');
  fs.unlinkSync(path.join(a.vault, 'n.md')); a.store.captureLocal();
  a.store.bind('another-account');
  assert.deepEqual(a.store.state.records, {}); assert.deepEqual(a.store.state.baseline, {});
});

test('invalid paths and malformed manifests fail before writing library data', async t => {
  const { make } = fixture(t), a = make();
  for (const name of ['../escape.md', 'C:/escape.md', 'x\\y.md', '.obsidian/config', 'CON.txt', 'trailing./x.md']) assert.throws(() => safePath(a.vault, name));
  assert.throws(() => validateManifest({ format: FORMAT, records: { 'vault/a': { versions: [] } } }));
  const map = {}; edit(map, 'vault/../escape', { hash: 'a'.repeat(64), size: 1 }, A, {});
  assert.throws(() => a.store.apply(map, {}));
  assert.equal(fs.readdirSync(a.vault).length, 0);
});

test('missing local PDFs stop synchronization instead of distributing data loss', async t => {
  const { make, drive } = fixture(t), a = make(); a.add();
  fs.unlinkSync(path.join(a.filesDir, `${ITEM}.pdf`));
  await assert.rejects(a.store.sync(drive), /PDF 文件缺失/);
});

test('simultaneous first syncs retain each device head and converge afterwards', async t => {
  const { make, drive, entries } = fixture(t), a = make(), b = make(), c = make();
  a.note('a.md', 'A'); b.note('b.md', 'B'); c.note('c.md', 'C');
  await Promise.all([a.store.sync(drive), b.store.sync(drive), c.store.sync(drive)]);
  assert.equal([...entries.values()].filter(f => f.appProperties.role === 'head').length, 3);
  await a.store.sync(drive); await b.store.sync(drive); await c.store.sync(drive);
  for (const device of [a, b, c]) assert.deepEqual(fs.readdirSync(device.vault).sort(), ['a.md', 'b.md', 'c.md']);
});

test('malformed rows cannot replace valid local files before validation fails', async t => {
  const { make, drive } = fixture(t), a = make();
  a.note('n.md', 'keep me'); await a.store.sync(drive);
  const records = structuredClone(a.store.state.records), vector = contextOf(records);
  edit(records, `item/${ITEM}`, true, A, vector);
  assert.throws(() => a.store.apply(records, a.store.scan()), /必需字段/);
  assert.equal(fs.readFileSync(path.join(a.vault, 'n.md'), 'utf8'), 'keep me');
});
