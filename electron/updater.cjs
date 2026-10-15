// Auto-update from GitHub Releases (electron-updater).
// Checks on launch and every 4 h, downloads in the background, then asks to restart.
// Only the NSIS installer build can update itself; the portable exe and `npm run app` just report status.
const { app, dialog, BrowserWindow } = require('electron');

let autoUpdater = null;
let state = { status: 'idle', version: app.getVersion(), available: null, progress: 0, error: '', checkedAt: 0 };
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) { try { fn(state); } catch { /* window gone */ } }
}

// portable builds run from a temp dir and set this env var; dev runs are not packaged
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
const updatable = () => app.isPackaged && !isPortable() && process.platform === 'win32';

const focusedWin = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;

function initUpdater() {
  if (!updatable()) {
    set({ status: 'unsupported', reason: isPortable() ? '免安装版不能自动更新，请到发布页下载新版本' : '开发模式不检查更新' });
    return;
  }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;              // download in the background as soon as a release is found
  autoUpdater.autoInstallOnAppQuit = true;      // if the user ignores the prompt, install on next quit
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info() {}, warn: console.warn, error: console.error, debug() {} };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-not-available', () => set({ status: 'latest', available: null, checkedAt: Date.now() }));
  autoUpdater.on('update-available', info => set({ status: 'downloading', available: info.version, progress: 0, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', p => set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
  autoUpdater.on('error', e => {
    set({ status: 'error', error: friendly(e), checkedAt: Date.now() });
    scheduleRetry(e);
  });
  autoUpdater.on('update-not-available', () => { retries = 0; });
  autoUpdater.on('update-downloaded', () => { retries = 0; });
  autoUpdater.on('update-downloaded', info => {
    set({ status: 'downloaded', available: info.version, progress: 100 });
    promptRestart(info.version);
  });

  // First check shortly after launch so startup isn't slowed, then every 4 hours
  setTimeout(() => checkForUpdates(), 8000);
  setInterval(() => checkForUpdates(), 4 * 60 * 60 * 1000);
}

// manual=true (menu / settings button): report the outcome even when there is nothing new
async function checkForUpdates({ manual = false } = {}) {
  if (!autoUpdater) {
    if (manual) dialog.showMessageBox(focusedWin(), { type: 'info', message: '无法自动更新', detail: state.reason || '' });
    return state;
  }
  if (state.status === 'downloading' || state.status === 'checking') return state;
  if (state.status === 'downloaded') { if (manual) promptRestart(state.available); return state; }
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { set({ status: 'error', error: friendly(e), checkedAt: Date.now() }); }
  if (manual) {
    if (state.status === 'latest') dialog.showMessageBox(focusedWin(), { type: 'info', message: '已是最新版本', detail: `当前版本 ${app.getVersion()}` });
    else if (state.status === 'error') dialog.showMessageBox(focusedWin(), { type: 'warning', message: '检查更新失败', detail: state.error });
    else if (state.status === 'downloading') dialog.showMessageBox(focusedWin(), { type: 'info', message: `发现新版本 ${state.available}`, detail: '正在后台下载，完成后会提示你重启。' });
  }
  return state;
}

// Proxies and GitHub drop connections now and then; a network error retries quickly
// (1, 3, 10, 30 min) instead of waiting for the next 4-hour check
let retries = 0, retryTimer = null;
const RETRY_MIN = [1, 3, 10, 30];
function scheduleRetry(e) {
  if (!/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|net::|socket hang up/i.test(String(e?.message || e))) return;
  if (retries >= RETRY_MIN.length || retryTimer) return;
  const ms = RETRY_MIN[retries++] * 60 * 1000;
  retryTimer = setTimeout(() => { retryTimer = null; checkForUpdates(); }, ms);
}

let prompted = '';
async function promptRestart(version) {
  if (prompted === version) return;   // ask once per version; the top-bar button stays available
  prompted = version;
  const { response } = await dialog.showMessageBox(focusedWin(), {
    type: 'info', buttons: ['立即重启更新', '稍后'], defaultId: 0, cancelId: 1,
    message: `新版本 ${version} 已下载`,
    detail: '重启后完成更新。你的文库、笔记和设置不受影响。选「稍后」则会在下次退出时自动安装。',
  });
  if (response === 0) installNow();
}

function installNow() {
  if (!autoUpdater || state.status !== 'downloaded') return { ok: false, reason: '还没有下载好的更新' };
  // isSilent=false shows the installer progress; isForceRunAfter=true relaunches the app afterwards
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|net::/i.test(m)) return '连不上 GitHub（网络或代理问题），稍后会自动重试';
  if (/404|latest\.yml/i.test(m)) return '发布页上还没有可用的安装包';
  return m.split('\n')[0].slice(0, 200);
}

module.exports = {
  initUpdater, checkForUpdates, installNow, updatable,
  getUpdateState: () => state,
  onUpdateState: fn => { listeners.add(fn); return () => listeners.delete(fn); },
};
