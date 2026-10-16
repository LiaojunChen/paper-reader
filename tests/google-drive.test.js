import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoogleDrive } from '../server/google-drive.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
function setup(t, fetcher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-google-'));
  const drive = new GoogleDrive(dir, () => {}, fetcher);
  drive.configure({ clientId: 'test.apps.googleusercontent.com', clientSecret: 'desktop-secret' });
  t.after(() => { drive.cancelAuth(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { drive, dir };
}
const json = data => Response.json(data);

test('OAuth uses PKCE and state, and only persists credentials after a successful callback', async t => {
  let authUrl, connected = '', error;
  const { drive, dir } = setup(t, async (url, options) => {
    if (url.includes('/token')) {
      const params = options.body;
      assert.equal(params.get('client_secret'), 'desktop-secret');
      assert.equal(params.get('code'), 'authorization-code');
      assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
      assert.equal(params.get('redirect_uri'), authUrl.searchParams.get('redirect_uri'));
      return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: SCOPE });
    }
    assert.ok(url.includes('/about?')); assert.equal(options.headers.Authorization, 'Bearer access');
    return json({ user: { permissionId: 'account-id', emailAddress: 'reader@example.com' } });
  });
  const result = await drive.beginAuth(binding => { connected = binding; }, e => { error = e; });
  authUrl = new URL(result.url);
  assert.equal(authUrl.origin, 'https://accounts.google.com');
  assert.equal(authUrl.searchParams.get('scope'), SCOPE);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(drive.status().connected, false);
  const callback = new URL(authUrl.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'authorization-code');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(drive.status().authorizing, true);
  callback.searchParams.set('state', authUrl.searchParams.get('state'));
  const response = await fetch(callback);
  assert.equal(response.status, 200); await response.text();
  assert.equal(error, undefined); assert.ok(connected);
  assert.equal(drive.auth().refreshToken, 'refresh');
  assert.equal(drive.status().account.email, 'reader@example.com');
  assert.equal(drive.status().connected, true);
  assert.ok(!JSON.stringify(drive.status()).includes('refresh'));
  drive.disconnect();
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
});

test('denied OAuth never connects and clears pending authorization', async t => {
  const { drive } = setup(t, () => { throw new Error('unexpected request'); });
  let error;
  const url = new URL((await drive.beginAuth(() => assert.fail('connected'), e => { error = e; })).url);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(callback)).status, 400);
  assert.match(error.message, /取消/); assert.equal(drive.status().connected, false); assert.equal(drive.status().authorizing, false);
});

test('token refresh is serialized and retries a rejected access token', async t => {
  let tokens = 0, requests = 0;
  const { drive, dir } = setup(t, async (url, options) => {
    if (url.includes('/token')) { tokens++; assert.equal(options.body.get('refresh_token'), 'saved-refresh'); return json({ access_token: `access-${tokens}` }); }
    requests++;
    if (requests === 1) return new Response('', { status: 401 });
    return json({ files: [] });
  });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ local: { refreshToken: 'saved-refresh', binding: 'id' } }));
  const values = await Promise.all([drive.accessToken(), drive.accessToken()]);
  assert.deepEqual(values, ['access-1', 'access-1']); assert.equal(tokens, 1);
  await drive.list(); assert.equal(tokens, 2); assert.equal(requests, 2);
});

test('Drive listing paginates and never sends tokens to other origins', async t => {
  let count = 0;
  const { drive } = setup(t, async url => {
    count++;
    assert.equal(new URL(url).searchParams.get('spaces'), 'appDataFolder');
    if (count === 1) return json({ files: [{ id: '1' }], nextPageToken: 'next' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'next');
    return json({ files: [{ id: '2' }] });
  });
  drive.token = { access: 'access', expires: Date.now() + 3600000 };
  assert.deepEqual(await drive.list(), [{ id: '1' }, { id: '2' }]);
  await assert.rejects(drive.request('https://evil.example/upload'), /无效的上传地址/);
  assert.equal(count, 2);
});

test('resumable uploads use chunk ranges and publish metadata in appDataFolder', async t => {
  const ranges = [];
  const { drive } = setup(t, async (url, options) => {
    if (options.method === 'POST') {
      const meta = JSON.parse(options.body);
      assert.deepEqual(meta.parents, ['appDataFolder']); assert.equal(meta.appProperties.role, 'blob');
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/session' } });
    }
    ranges.push(options.headers['Content-Range']);
    if (ranges.length === 1) return new Response(null, { status: 308, headers: { range: 'bytes=0-8388607' } });
    return json({ id: 'uploaded' });
  });
  drive.token = { access: 'access', expires: Date.now() + 3600000 };
  assert.deepEqual(await drive.upload('test', Buffer.alloc(9 * 1024 * 1024), 'blob'), { id: 'uploaded' });
  assert.deepEqual(ranges, ['bytes 0-8388607/9437184', 'bytes 8388608-9437183/9437184']);
});

test('corrupted downloads are discarded and existing files are untouched', async t => {
  const { drive, dir } = setup(t, async () => new Response('bad data'));
  drive.token = { access: 'access', expires: Date.now() + 3600000 };
  const file = path.join(dir, 'download'); fs.writeFileSync(file, 'previous');
  await assert.rejects(drive.download('blob-id', file, '0'.repeat(64)), /校验失败/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous'); assert.equal(fs.existsSync(file + '.download'), false);
});

test('empty notes use multipart upload and can be created without a resumable session', async t => {
  const { drive } = setup(t, async (url, options) => {
    assert.equal(new URL(url).searchParams.get('uploadType'), 'multipart');
    assert.match(options.headers['Content-Type'], /multipart\/related; boundary=/);
    const body = options.body.toString('utf8');
    assert.match(body, /"parents":\["appDataFolder"\]/);
    assert.match(body, /Content-Type: application\/octet-stream\r\n\r\n\r\n--paper-reader-/);
    return json({ id: 'empty' });
  });
  drive.token = { access: 'access', expires: Date.now() + 3600000 };
  assert.deepEqual(await drive.upload('empty-note', Buffer.alloc(0), 'blob'), { id: 'empty' });
});

test('canceling while the token exchange is in flight cannot reconnect the account', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { drive } = setup(t, async url => {
    if (url.includes('/token')) {
      started(); await new Promise(resolve => { release = resolve; });
      return json({ access_token: 'access', refresh_token: 'refresh', scope: SCOPE });
    }
    return json({ user: { permissionId: 'account' } });
  });
  let connected = false;
  const url = new URL((await drive.beginAuth(() => { connected = true; }, () => {})).url);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'code');
  const response = fetch(callback); await ready;
  drive.disconnect(); release();
  assert.equal((await response).status, 400);
  assert.equal(connected, false); assert.equal(drive.status().connected, false);
});

test('injected system encryption keeps client_secret out of the config JSON', t => {
  const { drive, dir } = setup(t, () => assert.fail('network'));
  drive.setCodec({ encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  drive.configure({ clientSecret: 'system-protected-secret' });
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('system-protected-secret'));
  assert.equal(drive.credentials().clientSecret, 'system-protected-secret');
});
