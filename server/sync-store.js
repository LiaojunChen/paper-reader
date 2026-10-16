import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJSON } from './google-drive.js';
import { FORMAT, capture, equal, materialize, mergeMaps, preserveFileConflicts, validateManifest } from './sync-model.js';

const ID = /^[a-f0-9]{16}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const fileKey = key => /^(vault|pdf|text)\//.test(key);
const error = message => new Error(message);

// Use the same portable path rules on Windows/macOS/Linux. Do not follow links:
// a synced attachment must never be able to write outside its configured root.
export function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1800 || relative.includes('\\')) throw error('无效的同步文件路径');
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f<>:"|?*]/.test(p) || /[. ]$/.test(p) || (p.startsWith('.') && p !== '.paper-reader.json') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw error('同步文件名不兼容或包含保留路径');
  root = path.resolve(root);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw error('同步目录不能是符号链接');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw error('同步路径不能经过符号链接');
  }
  if (!current.startsWith(root + path.sep)) throw error('同步路径不在文库中');
  return current;
}

export class SyncStore {
  constructor({ db, dataDir, filesDir, textDir, vaultDir, invalidate = () => {}, onApplied = () => {} }) {
    Object.assign(this, { db, dataDir, filesDir, textDir, vaultDir, invalidate, onApplied });
    this.dir = path.join(dataDir, 'sync');
    this.blobsDir = path.join(this.dir, 'blobs');
    fs.mkdirSync(this.blobsDir, { recursive: true });
    this.cache = new Map();
    this.columns = {};
    this.required = {};
    for (const [prefix, table] of [['item', 'items'], ['ann', 'annotations']]) {
      // Operational state belongs to the machine running that task.
      const schema = db.prepare(`PRAGMA table_info(${table})`).all();
      this.columns[prefix] = schema.map(c => c.name).filter(c => !['id', 'meta_status', 'ai_status', 'ai_log'].includes(c));
      this.required[prefix] = schema.filter(c => c.notnull && this.columns[prefix].includes(c.name)).map(c => c.name);
    }
    this.stateFile = path.join(this.dir, 'state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw error('本地同步状态损坏，请先备份数据并检查 sync/state.json');
      this.state = { device: crypto.randomBytes(16).toString('hex'), records: {}, baseline: {}, binding: '', vault: '' };
      this.save();
    }
    validateManifest({ format: FORMAT, records: this.state.records });
    if (!/^[a-f0-9]{32}$/.test(this.state.device)) throw error('本地同步设备标识损坏');
  }
  save() { atomicJSON(this.stateFile, this.state); }
  bind(binding) {
    if (binding === this.state.binding) return;
    // Never carry an old account's tombstones into a different account/project.
    atomicJSON(path.join(this.dir, `state-before-account-${Date.now()}.json`), this.state);
    this.state = { device: crypto.randomBytes(16).toString('hex'), records: {}, baseline: {}, binding, vault: '', lastSync: null };
    this.cache.clear(); this.save();
  }
  checkVault() {
    const vault = path.resolve(this.vaultDir());
    if (this.state.vault && this.state.vault !== vault) throw error('笔记库路径已更改。为避免把原笔记当作删除同步，请切回原路径，或断开后重新连接 Google Drive');
    return vault;
  }
  filePath(key) {
    const slash = key.indexOf('/'), group = key.slice(0, slash), rel = key.slice(slash + 1);
    return safePath(group === 'vault' ? this.checkVault() : group === 'pdf' ? this.filesDir : this.textDir, rel);
  }
  cacheFile(file) {
    const stat = fs.statSync(file);
    const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const old = this.cache.get(file);
    if (old?.signature === signature && fs.existsSync(path.join(this.blobsDir, old.value.hash))) return old.value;
    const digest = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    try { for (let count; (count = fs.readSync(fd, chunk, 0, chunk.length, null));) digest.update(chunk.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    const value = { hash: digest.digest('hex'), size: stat.size };
    const blob = path.join(this.blobsDir, value.hash);
    const created = !fs.existsSync(blob);
    if (created) fs.copyFileSync(file, blob);
    // An external editor can write during hashing/copying. Retry the next scan.
    const after = fs.statSync(file);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      if (created) fs.rmSync(blob, { force: true });
      throw error('文件正在被其他程序修改，请稍后重试同步');
    }
    this.cache.set(file, { signature, value });
    return value;
  }
  scan() {
    const values = Object.create(null);
    const vault = this.checkVault();
    for (const [prefix, table] of [['item', 'items'], ['ann', 'annotations']]) {
      for (const row of this.db.prepare(`SELECT * FROM ${table}`).all()) {
        values[`${prefix}/${row.id}`] = true;
        for (const col of this.columns[prefix]) if (row[col] !== null) values[`${prefix}/${row.id}/${col}`] = row[col];
        if (prefix === 'item') {
          if (row.file) {
            if (path.basename(row.file) !== row.file) throw error('文库中存在无效的 PDF 路径');
            const file = safePath(this.filesDir, row.file);
            if (!fs.existsSync(file)) throw error(`PDF 文件缺失：${row.title || row.file}。请恢复文件后同步`);
            values[`pdf/${row.file}`] = this.cacheFile(file);
          }
          const text = safePath(this.textDir, `${row.id}.txt`);
          if (fs.existsSync(text)) values[`text/${row.id}.txt`] = this.cacheFile(text);
        }
      }
    }
    const walk = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.paper-reader.json') continue;
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        const file = safePath(vault, name);
        if (entry.isSymbolicLink()) throw error(`同步不支持符号链接：${name}`);
        if (entry.isDirectory()) { values[`dir/${name}`] = true; walk(file, name); }
        else if (entry.isFile()) values[`vault/${name}`] = this.cacheFile(file);
      }
    };
    walk(vault);
    return values;
  }
  captureLocal() {
    const current = this.scan();
    capture(this.state.records, this.state.baseline, current, this.state.device);
    this.state.baseline = current;
    this.state.vault = path.resolve(this.vaultDir());
    this.save();
    return current;
  }
  validateValues(records) {
    validateManifest({ format: FORMAT, records });
    for (const [key, record] of Object.entries(records)) {
      const [kind, id, field, ...rest] = key.split('/');
      if (['item', 'ann'].includes(kind)) {
        if (!ID.test(id) || rest.length || (field && !this.columns[kind].includes(field))) throw error('同步清单包含不支持的数据库字段');
      } else {
        const rel = key.slice(kind.length + 1);
        safePath(kind === 'dir' || kind === 'vault' ? this.checkVault() : kind === 'pdf' ? this.filesDir : this.textDir, rel);
        if (kind === 'pdf' && !/^[a-f0-9]{16}\.pdf$/.test(rel)) throw error('同步 PDF 路径无效');
        if (kind === 'text' && !/^[a-f0-9]{16}\.txt$/.test(rel)) throw error('同步文本路径无效');
      }
      for (const v of record.versions) {
        const value = v.value;
        if (value === null) continue;
        if (fileKey(key)) {
          if (!DIGEST.test(value?.hash) || !Number.isSafeInteger(value.size) || value.size < 0) throw error('同步附件信息无效');
        } else if (kind === 'dir' || !field) {
          if (value !== true) throw error('同步记录状态无效');
        } else if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) throw error('同步字段值无效');
        if (field === 'file' && value && !/^[a-f0-9]{16}\.pdf$/.test(value)) throw error('同步 PDF 文件名无效');
        if (field === 'folder' && value) safePath(this.checkVault(), value);
        if (field === 'item_id' && !ID.test(value)) throw error('同步批注关联无效');
      }
    }
    const live = materialize(records), paths = new Map();
    for (const key of Object.keys(live)) {
      const [kind, id, field] = key.split('/');
      if (!['item', 'ann'].includes(kind) || field) continue;
      for (const column of this.required[kind]) if (live[`${key}/${column}`] === undefined) throw error(`同步记录缺少必需字段：${column}`);
      if (kind === 'item') {
        const file = live[`${key}/file`];
        if (file && !live[`pdf/${file}`]) throw error('同步文献没有对应的 PDF 附件');
      }
    }
    for (const key of Object.keys(live)) {
      if (!/^(vault|dir)\//.test(key)) continue;
      const rel = key.slice(key.indexOf('/') + 1), folded = rel.toLowerCase();
      if (paths.has(folded) && paths.get(folded) !== key) throw error(`同步文件路径大小写冲突：${rel}。请先在原设备重命名`);
      paths.set(folded, key);
    }
    for (const [rel, key] of paths) {
      let parent = rel;
      while (parent.includes('/')) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        if (paths.get(parent)?.startsWith('vault/')) throw error(`同步文件与文件夹路径冲突：${key}`);
      }
    }
    return live;
  }
  blobVersions(records) {
    const hashes = new Map();
    for (const [key, record] of Object.entries(records)) if (fileKey(key)) {
      for (const version of record.versions) if (version.value) hashes.set(version.value.hash, version.value);
    }
    return hashes;
  }
  async pullBlobs(records, remote, drive, progress) {
    const needed = this.blobVersions(records);
    let i = 0;
    for (const [digest, value] of needed) {
      const destination = path.join(this.blobsDir, digest);
      if (!fs.existsSync(destination)) {
        const entry = remote.get(digest);
        if (!entry) throw error('云端附件缺失，已停止同步并保留本地数据。请在原设备重新同步');
        progress(`下载附件 ${i + 1}/${needed.size}`);
        await drive.download(entry.id, destination, digest);
        if (fs.statSync(destination).size !== value.size) { fs.rmSync(destination, { force: true }); throw error('云端附件大小校验失败'); }
      }
      i++;
    }
  }
  apply(records, current) {
    const desired = this.validateValues(records);
    const changes = new Set([...Object.keys(current), ...Object.keys(desired)]);
    const changed = [...changes].filter(key => !equal(current[key] ?? null, desired[key] ?? null));
    if (!changed.length) { this.state.records = records; this.save(); return { changed: 0 }; }
    const backup = path.join(this.dir, 'backups', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    atomicJSON(path.join(backup, 'values.json'), current);
    // Save the old database fields and changed files before touching the library.
    for (const key of changed) if (fileKey(key) && current[key]) {
      const destination = path.join(backup, key);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(this.filePath(key), destination);
    }
    // All needed payloads were downloaded and verified before this synchronous
    // section. No request handler can interleave a save between re-scan and apply.
    for (const key of Object.keys(desired).filter(k => k.startsWith('dir/')).sort((a, b) => a.length - b.length)) fs.mkdirSync(safePath(this.checkVault(), key.slice(4)), { recursive: true });
    for (const key of changed) if (fileKey(key) && desired[key]) {
      const destination = this.filePath(key);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const tmp = path.join(path.dirname(destination), `.paper-sync-${crypto.randomUUID()}.tmp`);
      try { fs.copyFileSync(path.join(this.blobsDir, desired[key].hash), tmp); fs.renameSync(tmp, destination); }
      finally { fs.rmSync(tmp, { force: true }); }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [prefix, table] of [['item', 'items'], ['ann', 'annotations']]) {
        for (const key of changed) {
          if (!key.startsWith(prefix + '/') || key.split('/').length !== 2 || desired[key]) continue;
          this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(key.split('/')[1]);
        }
      }
      for (const [prefix, table] of [['item', 'items'], ['ann', 'annotations']]) {
        const ids = Object.keys(desired).filter(k => k.startsWith(prefix + '/') && k.split('/').length === 2).map(k => k.split('/')[1]);
        for (const id of ids) {
          const row = Object.fromEntries(this.columns[prefix].map(col => [col, desired[`${prefix}/${id}/${col}`] ?? null]));
          if (prefix === 'ann' && !desired[`item/${row.item_id}`]) continue;
          if (prefix === 'item' && row.file && !desired[`pdf/${row.file}`]) throw error('同步文献没有对应的 PDF 附件');
          const columns = ['id', ...this.columns[prefix]];
          const updates = this.columns[prefix].map(col => `${col}=excluded.${col}`).join(',');
          this.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${updates}`).run(id, ...this.columns[prefix].map(col => row[col]));
          if (prefix === 'item') this.db.prepare("UPDATE items SET meta_status='ok' WHERE id=? AND meta_status='pending'").run(id);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    for (const key of changed) if (fileKey(key) && current[key] && !desired[key]) fs.rmSync(this.filePath(key), { force: true });
    for (const key of changed.filter(k => k.startsWith('dir/') && !desired[k]).sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(safePath(this.checkVault(), key.slice(4))); }
      catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
    }
    this.invalidate();
    this.state.records = records;
    this.state.baseline = this.scan();
    this.save();
    this.onApplied(changed, desired);
    return { changed: changed.length, backup };
  }
  async sync(drive, progress = () => {}) {
    const auth = drive.auth();
    if (!auth?.binding) throw error('请先连接 Google Drive');
    this.bind(auth.binding);
    progress('检查本地改动');
    this.captureLocal();
    progress('读取云端改动');
    const files = await drive.list();
    const remoteBlobs = new Map();
    for (const f of files) if (f.appProperties?.role === 'blob' && DIGEST.test(f.appProperties.hash)) remoteBlobs.set(f.appProperties.hash, f);
    let remote = {};
    const heads = files.filter(f => f.appProperties?.role === 'head');
    for (const head of heads) {
      const manifest = validateManifest(await drive.readManifest(head.id));
      this.validateValues(manifest.records);
      remote = mergeMaps(remote, manifest.records);
    }
    let merged = mergeMaps(this.state.records, remote);
    this.validateValues(merged);
    await this.pullBlobs(merged, remoteBlobs, drive, progress);
    // A user can keep editing while requests are in flight. Capture those edits
    // again before applying remote values; their context excludes unseen edits.
    const latest = this.captureLocal();
    merged = mergeMaps(this.state.records, remote);
    const conflicts = preserveFileConflicts(merged);
    progress('合并文库');
    const result = this.apply(merged, latest);
    const payloads = this.blobVersions(merged);
    let i = 0;
    for (const [digest] of payloads) {
      if (!remoteBlobs.has(digest)) {
        progress(`上传附件 ${i + 1}/${payloads.size}`);
        remoteBlobs.set(digest, await drive.uploadFile(path.join(this.blobsDir, digest), digest));
      }
      i++;
    }
    progress('保存同步清单');
    const own = heads.find(h => h.appProperties?.device === this.state.device);
    const manifest = { format: FORMAT, device: this.state.device, records: merged };
    // Each installation only updates its own head; two different devices never
    // overwrite a shared manifest. Upload the manifest after all its payloads.
    await drive.upload(`device-${this.state.device}.json`, Buffer.from(JSON.stringify(manifest)), 'head', { device: this.state.device }, own?.id);
    this.state.lastSync = Date.now(); this.save();
    return { ...result, conflicts, lastSync: this.state.lastSync };
  }
}
