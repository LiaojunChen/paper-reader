import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hash } from './sync-model.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const APP = 'paper-reader-v1';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export class GoogleDrive {
  constructor(dir, onChange = () => {}, fetcher = fetch) {
    this.dir = dir;
    this.onChange = onChange;
    this.fetcher = fetcher;
    this.codec = null;
    this.pending = null;
    this.token = null;
    this.refreshing = null;
    this.active = false;
    try { this.config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.config = { autoSync: true }; }
  }
  setCodec(codec) { this.codec = codec; }
  encode(value) {
    if (this.codec) return { encrypted: this.codec.encrypt(JSON.stringify(value)) };
    if (process.env.PAPER_EMBEDDED) throw fail('系统凭据加密尚未就绪', 503);
    return { local: value };
  }
  decode(value) {
    if (!value) return null;
    if (value.encrypted) {
      if (!this.codec) throw fail('无法解密 Google 登录信息，请在原系统用户下打开应用或重新连接');
      return JSON.parse(this.codec.decrypt(value.encrypted));
    }
    return value.local;
  }
  credentials() {
    return { clientId: this.config.clientId || process.env.PAPER_GOOGLE_CLIENT_ID || '',
      clientSecret: this.decode(this.config.secret)?.value || process.env.PAPER_GOOGLE_CLIENT_SECRET || '' };
  }
  savedAuth() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'credentials.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  auth() { return this.decode(this.savedAuth()); }
  status() {
    return { connected: !!this.savedAuth(), authorizing: !!this.pending,
      clientId: this.config.clientId || process.env.PAPER_GOOGLE_CLIENT_ID || '',
      hasClientSecret: !!(this.config.secret || process.env.PAPER_GOOGLE_CLIENT_SECRET), autoSync: this.config.autoSync !== false,
      account: this.config.account || null };
  }
  configure(patch) {
    if (this.active || this.pending) throw fail('请等待当前同步或登录完成', 409);
    const clientId = String(patch.clientId ?? this.status().clientId).trim();
    if (clientId && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw fail('请填写 Google 桌面应用的 Client ID');
    if (this.savedAuth() && (clientId !== this.status().clientId || patch.clientSecret)) throw fail('修改 OAuth 凭据前请先断开连接', 409);
    this.config.clientId = clientId;
    if (patch.clientSecret !== undefined) this.config.secret = patch.clientSecret ? this.encode({ value: String(patch.clientSecret).trim() }) : undefined;
    if (patch.autoSync !== undefined) this.config.autoSync = !!patch.autoSync;
    this.saveConfig();
    this.onChange();
    return this.status();
  }
  saveConfig() { atomicJSON(path.join(this.dir, 'config.json'), this.config); }

  async tokenRequest(params) {
    const { clientId, clientSecret } = this.credentials();
    const body = new URLSearchParams({ client_id: clientId, ...params });
    if (clientSecret) body.set('client_secret', clientSecret);
    const response = await this.fetcher(TOKEN, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok) throw fail(data.error === 'invalid_grant' ? 'Google 授权已失效，请断开后重新连接' : `Google 登录失败：${data.error || response.status}。请检查桌面应用 OAuth 凭据`, 401);
    if (!data.access_token) throw fail('Google 未返回访问令牌', 401);
    this.token = { access: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
    return data;
  }
  async accessToken() {
    if (this.token?.expires > Date.now() + 60000) return this.token.access;
    if (!this.refreshing) this.refreshing = (async () => {
      const auth = this.auth();
      if (!auth?.refreshToken) throw fail('请先连接 Google Drive', 401);
      const data = await this.tokenRequest({ refresh_token: auth.refreshToken, grant_type: 'refresh_token' });
      if (data.refresh_token) atomicJSON(path.join(this.dir, 'credentials.json'), this.encode({ ...auth, refreshToken: data.refresh_token }));
      return this.token.access;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async request(url, options = {}, accepted = []) {
    // Never forward a bearer token to an arbitrary resumable-session URL.
    const target = new URL(url);
    if (target.origin !== 'https://www.googleapis.com') throw fail('Google Drive 返回了无效的上传地址');
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.fetcher(url, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(120000) });
      } catch (e) {
        if (attempt === 3 || e.status) throw e;
        await pause(500 * 2 ** attempt); continue;
      }
      if (response.ok || accepted.includes(response.status)) return response;
      if (response.status === 401 && attempt < 3) { this.token = null; await response.body?.cancel(); continue; }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const delay = Math.min(15000, (+response.headers.get('retry-after') || 0) * 1000 || 500 * 2 ** attempt);
        await response.body?.cancel(); await pause(delay); continue;
      }
      let reason = ''; try { const data = await response.json(); reason = data.error?.errors?.[0]?.reason || data.error?.status || ''; } catch { /* no JSON */ }
      throw fail(`Google Drive 请求失败（${response.status}${reason ? ` · ${reason}` : ''}）${response.status === 403 ? '，请检查 Drive API 是否启用、账号权限及存储空间' : ''}`, response.status);
    }
  }

  async beginAuth(onConnected, onError) {
    if (this.pending || this.active) throw fail('已有同步或登录正在进行', 409);
    if (this.savedAuth()) throw fail('已连接 Google Drive，请先断开连接', 409);
    if (!this.credentials().clientId) throw fail('请先保存 Google 桌面应用 OAuth 凭据');
    const state = crypto.randomBytes(32).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let finishing = false;
    const listener = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) { res.writeHead(400); res.end('无效的登录回调。'); return; }
      if (finishing) { res.writeHead(409); res.end('登录正在处理中。'); return; }
      finishing = true;
      try {
        if (url.searchParams.has('error')) throw fail('已取消 Google 授权');
        const code = url.searchParams.get('code');
        if (!code) throw fail('Google 未返回授权码');
        const data = await this.tokenRequest({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
        if (!data.refresh_token || !data.scope?.split(' ').includes(SCOPE)) throw fail('Google 未授予后台同步权限，请重新连接并允许应用数据访问');
        // The access token is already in memory; no refresh-token file is needed yet.
        const about = await (await this.request(`${API}/about?fields=user(permissionId,emailAddress,displayName)`)).json();
        if (!about.user?.permissionId) throw fail('无法识别 Google 账号');
        if (this.pending?.listener !== listener) throw fail('登录已取消');
        const binding = hash(`${this.credentials().clientId}:${about.user.permissionId}`);
        const credentials = this.encode({ refreshToken: data.refresh_token, binding });
        await onConnected(binding);
        if (this.pending?.listener !== listener) throw fail('登录已取消');
        this.config.account = { email: about.user.emailAddress || '', name: about.user.displayName || '' };
        this.saveConfig();
        atomicJSON(path.join(this.dir, 'credentials.json'), credentials);
        res.end('Google Drive 已连接。可以关闭此页面，返回 Paper Reader。');
        this.cancelAuth(); this.onChange();
      } catch (e) {
        this.token = null;
        res.writeHead(400); res.end(e.message);
        this.cancelAuth(); onError(e); this.onChange();
      }
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const redirect = `http://127.0.0.1:${listener.address().port}`;
    const timer = setTimeout(() => { this.cancelAuth(); onError(fail('Google 登录超时，请重试')); this.onChange(); }, 5 * 60000);
    timer.unref(); listener.unref();
    this.pending = { listener, timer };
    const params = new URLSearchParams({ client_id: this.credentials().clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
      state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' });
    this.onChange();
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  }
  cancelAuth() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); this.pending.listener.close(); this.pending = null;
  }
  disconnect() {
    if (this.active) throw fail('请等待当前同步完成后断开', 409);
    this.cancelAuth(); this.token = null;
    fs.rmSync(path.join(this.dir, 'credentials.json'), { force: true });
    delete this.config.account; this.saveConfig(); this.onChange();
  }

  async list() {
    const files = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: `trashed = false and appProperties has { key='app' and value='${APP}' }`,
        fields: 'nextPageToken,files(id,name,appProperties,size)', pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      const data = await (await this.request(`${API}/files?${query}`)).json();
      files.push(...(data.files || [])); pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }
  async readManifest(id) {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`);
    const chunks = []; let length = 0;
    for await (const chunk of res.body) { length += chunk.length; if (length > 100 * 1024 * 1024) throw fail('云端同步清单过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async download(id, destination, expectedHash) {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`);
    const tmp = `${destination}.download`;
    const digest = crypto.createHash('sha256');
    const source = Readable.fromWeb(res.body);
    source.on('data', chunk => digest.update(chunk));
    try {
      await pipeline(source, fs.createWriteStream(tmp, { mode: 0o600 }));
      if (digest.digest('hex') !== expectedHash) throw fail('同步文件校验失败，已保留本地内容');
      fs.renameSync(tmp, destination);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  async upload(name, body, role, extra = {}, id = '') {
    const size = body.size ?? body.length;
    const metadata = { name, appProperties: { app: APP, role, ...extra }, ...(!id ? { parents: ['appDataFolder'] } : {}) };
    // Multipart handles small and empty notes in one request; it also avoids
    // ambiguous zero-byte resumable-session finalization.
    if (size <= 5 * 1024 * 1024) {
      const boundary = `paper-reader-${crypto.randomBytes(16).toString('hex')}`;
      const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body;
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const query = new URLSearchParams({ uploadType: 'multipart', fields: 'id,name,appProperties' });
      return (await this.request(`${UPLOAD}${id ? '/' + encodeURIComponent(id) : ''}?${query}`, {
        method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      })).json();
    }
    const query = new URLSearchParams({ uploadType: 'resumable', fields: 'id,name,appProperties' });
    const session = await this.request(`${UPLOAD}${id ? '/' + encodeURIComponent(id) : ''}?${query}`, {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(metadata),
    });
    const location = session.headers.get('location');
    if (!location) throw fail('Google Drive 未返回上传地址');
    // Replayable Blob/Buffer bodies allow retry after transient errors; interrupted
    // chunks are queried before continuing so an acknowledged range isn't resent.
    const chunkSize = 8 * 1024 * 1024;
    let offset = 0;
    for (let retries = 0; offset < size || size === 0;) {
      const end = Math.min(offset + chunkSize, size);
      const chunk = body instanceof Blob ? body.slice(offset, end) : body.subarray(offset, end);
      let res;
      try {
        res = await this.request(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': size ? `bytes ${offset}-${end - 1}/${size}` : 'bytes */0' }, body: chunk }, [308]);
      } catch (e) {
        if (++retries > 3 || (e.status && e.status < 500 && e.status !== 429)) throw e;
        res = await this.request(location, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, body: Buffer.alloc(0) }, [308]);
      }
      if (res.status !== 308) return res.json();
      const range = res.headers.get('range');
      const next = range ? Number(range.match(/(\d+)$/)?.[1]) + 1 : 0;
      if (!Number.isSafeInteger(next) || next < 0 || next > size || (next <= offset && ++retries > 3)) throw fail('Google Drive 上传没有继续，请稍后重试');
      offset = next;
    }
    throw fail('Google Drive 上传未完成');
  }
  uploadFile(file, digest) { return openAsBlob(file).then(blob => this.upload(`blob-${digest}`, blob, 'blob', { hash: digest })); }
}
