// Obsidian-style vault: categories are real folders, notes are real .md files.
// Papers stay in the database; each paper that has notes gets its own folder, recognised
// by a hidden marker file so it survives renames/moves made in Obsidian.
//
//   vault/
//   ├── 具身推理/                     ← category folder
//   │   ├── ReAct Synergizing …/      ← paper folder (contains .paper-reader.json)
//   │   │   └── 读后笔记.md
//   │   └── 综述整理.md               ← standalone note, sibling of paper folders
//   └── .trash/                       ← deleted notes/folders (Obsidian convention)
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = '.paper-reader.json';
let vaultDir = '';
let watcher = null;
let cache = null;
let onChange = () => {};
let changeTimer = null;
let selfWriteUntil = 0;

export function setVaultChangeHandler(fn) { onChange = fn; }
export const getVaultDir = () => vaultDir;
export function invalidateVault() { cache = null; selfWriteUntil = Date.now() + 800; }

export function openVault(dir) {
  vaultDir = path.resolve(dir);
  fs.mkdirSync(vaultDir, { recursive: true });
  cache = null;
  watcher?.close();
  try {
    // Recursive watching is supported on Windows and macOS; on Linux we just rescan on demand
    const changed = new Set();
    watcher = fs.watch(vaultDir, { recursive: true }, (_ev, file) => {
      if (file && /(^|[\\/])\.(obsidian|git|trash)([\\/]|$)/.test(file)) return;
      cache = null;
      if (file) changed.add(String(file).split(path.sep).join('/'));
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        const files = [...changed]; changed.clear();
        onChange({ external: Date.now() > selfWriteUntil, files });
      }, 250);
    });
    watcher.on('error', () => {});
  } catch { watcher = null; }
}
const touched = () => { cache = null; selfWriteUntil = Date.now() + 800; };

// ---------- paths ----------
const toRel = abs => path.relative(vaultDir, abs).split(path.sep).join('/');
export function resolveIn(rel = '') {
  const abs = path.resolve(vaultDir, String(rel).replace(/^\/+/, ''));
  if (abs !== vaultDir && !abs.startsWith(vaultDir + path.sep)) throw Object.assign(new Error('路径不在笔记库内'), { status: 400 });
  return abs;
}
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
export function safeName(name, fallback = '未命名') {
  let s = String(name || '').replace(/[\\/:*?"<>|#^[\]\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (s.length > 80) s = s.slice(0, 80).trim();
  if (!s) s = fallback;
  if (RESERVED.test(s)) s += '_';
  return s;
}
function uniquePath(dir, base, ext = '') {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} ${i}${ext}`);
  return p;
}
const isHidden = n => n.startsWith('.');

// ---------- scan ----------
// Returns { folders: [{path,name,parent}], notes: [{id,title,dir,itemId,mtime}], paperDirs: Map(itemId → dir) }
export function scan() {
  if (cache) return cache;
  const folders = [], notes = [], paperDirs = new Map();
  const walk = (abs, paperId) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    let myPaper = paperId;
    if (!paperId && entries.some(e => e.isFile() && e.name === MARKER)) {
      try { myPaper = JSON.parse(fs.readFileSync(path.join(abs, MARKER), 'utf8')).id || null; } catch { myPaper = null; }
      if (myPaper) paperDirs.set(myPaper, toRel(abs));
    }
    if (!myPaper && abs !== vaultDir) {
      const rel = toRel(abs);
      folders.push({ path: rel, name: path.basename(abs), parent: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' });
    }
    for (const e of entries) {
      if (isHidden(e.name)) continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p, myPaper);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { /* vanished */ }
        const rel = toRel(p);
        notes.push({ id: rel, title: e.name.replace(/\.md$/i, ''), dir: toRel(abs) === '' ? '' : toRel(abs), itemId: myPaper || null, mtime });
      }
    }
  };
  walk(vaultDir, null);
  folders.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  cache = { folders, notes, paperDirs };
  return cache;
}

// ---------- folders ----------
export function createFolder(parent, name) {
  const dir = resolveIn(parent || '');
  const p = uniquePath(dir, safeName(name, '新建文件夹'));
  fs.mkdirSync(p, { recursive: true });
  touched();
  return toRel(p);
}
export function ensureFolder(rel) {
  if (!rel) return '';
  fs.mkdirSync(resolveIn(rel), { recursive: true });
  touched();
  return rel;
}
// Rename or move a folder; returns the new relative path
export function moveFolder(rel, { name, parent } = {}) {
  const src = resolveIn(rel);
  if (!fs.existsSync(src)) throw Object.assign(new Error('文件夹不存在'), { status: 404 });
  const newParent = parent !== undefined ? resolveIn(parent) : path.dirname(src);
  if (newParent === src || newParent.startsWith(src + path.sep)) throw Object.assign(new Error('不能移动到自身内部'), { status: 400 });
  const base = name !== undefined ? safeName(name, path.basename(src)) : path.basename(src);
  let dst = path.join(newParent, base);
  if (dst === src) return rel;
  if (fs.existsSync(dst)) dst = uniquePath(newParent, base);
  fs.mkdirSync(newParent, { recursive: true });
  fs.renameSync(src, dst);
  touched();
  return toRel(dst);
}
export function trashPath(rel) {
  const src = resolveIn(rel);
  if (!fs.existsSync(src) || src === vaultDir) return;
  const trash = path.join(vaultDir, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const ext = path.extname(src), base = path.basename(src, ext);
  fs.renameSync(src, uniquePath(trash, base, ext));
  touched();
}

// ---------- paper folders ----------
export function paperDir(itemId) { return scan().paperDirs.get(itemId) ?? null; }
// Create (or find) the folder for a paper inside its category folder
export function ensurePaperDir(item) {
  const existing = paperDir(item.id);
  if (existing != null) return existing;
  const parent = resolveIn(item.folder || '');
  fs.mkdirSync(parent, { recursive: true });
  const p = uniquePath(parent, safeName(item.title, '未命名文献'));
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, MARKER), JSON.stringify({ id: item.id, title: item.title }, null, 1));
  if (process.platform === 'win32') {
    // Hide the marker in Explorer as well (Obsidian already ignores dotfiles)
    import('node:child_process').then(({ spawn }) => spawn('attrib', ['+h', path.join(p, MARKER)], { windowsHide: true }).on('error', () => {})).catch(() => {});
  }
  touched();
  return toRel(p);
}
// Move a paper's folder (if it has one) into another category folder
export function movePaperDir(itemId, folder) {
  const dir = paperDir(itemId);
  if (dir == null) return null;
  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  if (parent === (folder || '')) return dir;
  return moveFolder(dir, { parent: folder || '' });
}

// ---------- notes ----------
export function readNote(id) {
  const p = resolveIn(id);
  if (!/\.md$/i.test(p) || !fs.existsSync(p)) throw Object.assign(new Error('笔记不存在'), { status: 404 });
  const st = fs.statSync(p);
  const n = scan().notes.find(x => x.id === id);
  return { id, title: path.basename(p, path.extname(p)), content: fs.readFileSync(p, 'utf8'), mtime: st.mtimeMs, dir: n?.dir ?? toRel(path.dirname(p)), itemId: n?.itemId ?? null };
}
export function writeNote(id, content) {
  const p = resolveIn(id);
  if (!/\.md$/i.test(p)) throw Object.assign(new Error('只能写入 .md 文件'), { status: 400 });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content ?? '', 'utf8');
  touched();
  return fs.statSync(p).mtimeMs;
}
export function createNote(dir, title, content = '') {
  const d = resolveIn(dir || '');
  fs.mkdirSync(d, { recursive: true });
  const p = uniquePath(d, safeName(title, '未命名笔记'), '.md');
  fs.writeFileSync(p, content, 'utf8');
  touched();
  return toRel(p);
}
// Rename and/or move a note; returns new id
export function moveNote(id, { title, dir } = {}) {
  const src = resolveIn(id);
  if (!fs.existsSync(src)) throw Object.assign(new Error('笔记不存在'), { status: 404 });
  const d = dir !== undefined ? resolveIn(dir) : path.dirname(src);
  const base = title !== undefined ? safeName(title, '未命名笔记') : path.basename(src, '.md');
  let dst = path.join(d, base + '.md');
  if (dst.toLowerCase() === src.toLowerCase() && dst === src) return id;
  if (fs.existsSync(dst) && dst.toLowerCase() !== src.toLowerCase()) dst = uniquePath(d, base, '.md');
  fs.mkdirSync(d, { recursive: true });
  fs.renameSync(src, dst);
  touched();
  return toRel(dst);
}

// Notes whose content matches q (case-insensitive); small vaults only need a linear scan
export function searchNotes(q) {
  const needle = q.toLowerCase();
  const out = [];
  for (const n of scan().notes) {
    if (n.title.toLowerCase().includes(needle)) { out.push(n); continue; }
    try { if (fs.readFileSync(resolveIn(n.id), 'utf8').toLowerCase().includes(needle)) out.push(n); } catch { /* vanished */ }
  }
  return out;
}
