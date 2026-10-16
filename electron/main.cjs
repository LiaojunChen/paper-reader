// Electron shell: runs the Express server in-process and shows it in a window.
const { app, BrowserWindow, shell, dialog, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const updater = require('./updater.cjs');

// Library lives in the user's app data, not inside the installed program folder
const DATA_DIR = path.join(app.getPath('userData'), 'library');
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.PAPER_DATA = DATA_DIR;
process.env.NODE_ENV = 'production';
process.env.PAPER_EMBEDDED = '1';
process.env.PAPER_ANY_PORT = '1';
// dist/ and node_modules/pdfjs-dist are unpacked next to the asar
process.env.PAPER_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : path.join(__dirname, '..');

let serverUrl = '';
const windows = new Set();

function createWindow(url, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1500, height: opts.height || 950, minWidth: 900, minHeight: 600,
    title: 'Paper Reader', backgroundColor: '#f4f5f7', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false },
  });
  win.loadURL(url);
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  // Note windows (window.open) become real Electron windows; external links go to the browser
  win.webContents.setWindowOpenHandler(({ url: target, frameName }) => {
    if (target.startsWith(serverUrl)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 820, height: 950, title: frameName || 'Note', autoHideMenuBar: true, backgroundColor: '#ffffff' } };
    }
    shell.openExternal(target);
    return { action: 'deny' };
  });
  return win;
}

async function startServer() {
  const mod = await import(`file://${path.join(__dirname, '..', 'server', 'index.js').replace(/\\/g, '/')}`);
  mod.setSyncCredentialCodec?.({
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存 Google 登录信息');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt(value) { return safeStorage.decryptString(Buffer.from(value, 'base64')); },
  });
  // The UI talks to the updater through the local server (/api/update), so no preload/IPC is needed
  mod.setUpdateController?.({
    state: updater.getUpdateState,
    check: () => updater.checkForUpdates({ manual: true }),
    install: updater.installNow,
    subscribe: updater.onUpdateState,
  });
  return mod.startServer();
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());
  try {
    const { url } = await startServer();
    serverUrl = url;
    createWindow(url);
    updater.initUpdater();
  } catch (e) {
    dialog.showErrorBox('启动失败', String(e?.stack || e));
    app.quit();
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(serverUrl); });
});

// macOS convention: closing the last window leaves the app (and its dock icon) running
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Single instance: focus the existing window instead of starting a second server
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => {
  const win = [...windows][0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 Paper Reader` },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => serverUrl && createWindow(serverUrl) },
        { label: '打开数据文件夹', click: () => shell.openPath(DATA_DIR) },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => updater.checkForUpdates({ manual: true }) },
        { label: '版本发布页', click: () => shell.openExternal('https://github.com/LiaojunChen/paper-reader/releases') },
        { type: 'separator' },
        { label: `关于 Paper Reader ${app.getVersion()}`, click: () => dialog.showMessageBox({ type: 'info', title: '关于', message: `Paper Reader ${app.getVersion()}`, detail: `Electron ${process.versions.electron} · Node ${process.versions.node}\n数据目录：${DATA_DIR}` }) },
      ],
    },
  ]);
}
