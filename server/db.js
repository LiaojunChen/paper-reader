// SQLite storage (node:sqlite, no native deps)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// PAPER_DATA is set by the desktop build to the per-user app-data folder
export const DATA_DIR = path.resolve(process.env.PAPER_DATA || path.join(import.meta.dirname, '..', 'data'));
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const TEXT_DIR = path.join(DATA_DIR, 'text');
for (const d of [DATA_DIR, FILES_DIR, TEXT_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', authors TEXT NOT NULL DEFAULT '[]',
  year TEXT DEFAULT '', venue TEXT DEFAULT '', abstract TEXT DEFAULT '', doi TEXT DEFAULT '',
  arxiv TEXT DEFAULT '', url TEXT DEFAULT '', file TEXT DEFAULT '', orig_name TEXT DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', meta_status TEXT DEFAULT 'pending',
  kind TEXT NOT NULL DEFAULT 'paper', content TEXT DEFAULT '',
  hash TEXT DEFAULT '', num_pages INTEGER DEFAULT 0, last_page INTEGER DEFAULT 1, starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  page INTEGER NOT NULL, color TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
  rects TEXT NOT NULL DEFAULT '[]', ref_index INTEGER, ai_status TEXT DEFAULT '', ai_reply TEXT DEFAULT '',
  ai_log TEXT DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Add columns introduced after the first release
// folder = vault-relative path of the category folder the paper lives in ('' = vault root / 未分类)
for (const [col, decl] of [['kind', "TEXT NOT NULL DEFAULT 'paper'"], ['content', "TEXT DEFAULT ''"], ['folder', "TEXT NOT NULL DEFAULT ''"]]) {
  const has = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('items', col);
  if (!has) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${decl}`);
}

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
export const now = () => Date.now();

const JSON_COLS = { authors: 1, tags: 1, refs: 1, rects: 1 };
export function decode(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of Object.keys(out)) if (JSON_COLS[k] && typeof out[k] === 'string') {
    try { out[k] = JSON.parse(out[k]); } catch { out[k] = []; }
  }
  return out;
}
export function encodeVal(k, v) { return JSON_COLS[k] ? JSON.stringify(v ?? []) : v; }

// Generic partial update restricted to an allow-list of columns
export function update(table, id, patch, allowed) {
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => encodeVal(k, patch[k]));
  const hasUpdated = ['items', 'notes', 'annotations'].includes(table);
  db.prepare(`UPDATE ${table} SET ${sets}${hasUpdated ? ', updated = ?' : ''} WHERE id = ?`)
    .run(...vals, ...(hasUpdated ? [now()] : []), id);
}

export function getSettings() {
  const s = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; }
  }
  return {
    llmProvider: 'openai', llmBaseUrl: 'https://api.openai.com/v1', llmApiKey: '', llmModel: 'gpt-4o-mini',
    targetLang: '简体中文', agentCommand: 'claude', agentModel: '', agentMaxBudget: '1', openalexKey: '',
    vaultDir: path.join(DATA_DIR, 'vault'),
    ...s,
  };
}
export function setSettings(patch) {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) st.run(k, JSON.stringify(v));
}
