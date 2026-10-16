import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('real server exposes sync settings, protects credentials, and saves a stale draft without losing the other version', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-reader-api-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', "const m = await import('./server/index.js'); await m.startServer(0);"], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PAPER_DATA: dir, PAPER_EMBEDDED: '1', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(async () => { child.kill(); await once(child, 'exit'); fs.rmSync(dir, { recursive: true, force: true }); });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.stderr.on('data', () => {});
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
  });
  const request = async (route, method = 'GET', body, headers = {}) => {
    const res = await fetch(url + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await request('/api/sync')).body.connected, false);
  assert.equal((await request('/api/sync/run', 'POST', {})).status, 401);
  assert.equal((await request('/api/sync/config', 'PUT', { autoSync: false }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/sync/config', 'PUT', { clientId: 'invalid' })).status, 400);
  const configured = await request('/api/sync/config', 'PUT', { clientId: 'test.apps.googleusercontent.com', autoSync: false });
  assert.equal(configured.status, 200); assert.equal(configured.body.autoSync, false);
  assert.equal((await request('/api/sync/connect', 'POST', {})).status, 200);
  assert.equal((await request('/api/sync')).body.authorizing, true);
  await request('/api/sync/disconnect', 'POST', {});
  assert.equal((await request('/api/sync')).body.authorizing, false);
  const n = (await request('/api/notes', 'POST', { title: 'Draft', content: 'base' })).body;
  const route = `/api/note?id=${encodeURIComponent(n.id)}`;
  await request(route, 'PUT', { content: 'remote revision' });
  const file = path.join(dir, 'vault', n.id);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  const saved = await request(route, 'PUT', { content: 'local draft', baseMtime: n.mtime });
  assert.equal(saved.status, 200); assert.equal(saved.body.content, 'local draft');
  const notes = (await request('/api/notes')).body;
  assert.equal(notes.length, 2);
  const copy = notes.find(note => note.id !== n.id);
  assert.equal((await request(`/api/note?id=${encodeURIComponent(copy.id)}`)).body.content, 'remote revision');
  const settings = (await request('/api/settings')).body;
  assert.equal(settings.clientId, undefined); assert.equal(settings.refreshToken, undefined);
});
