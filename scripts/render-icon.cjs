// Render build/icon.svg to build/icon.png (1024×1024), which electron-builder turns into .icns / .ico.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, frame: false,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024 }).toPNG();
  fs.writeFileSync(path.join(dir, 'icon.png'), png);
  console.log(`build/icon.png ${png.length} bytes`);
  app.quit();
});
