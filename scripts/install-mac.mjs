// Install the freshly built macOS app into /Applications, replacing the old version.
// The library lives in ~/Library/Application Support/Paper Reader, so it is untouched.
//
//   npm run install:mac   → build the dmg, then run this script
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('只能在 macOS 上运行');

const ROOT = path.resolve(import.meta.dirname, '..');
const src = path.join(ROOT, 'release', 'mac-arm64', 'Paper Reader.app');
const dest = '/Applications/Paper Reader.app';
if (!fs.existsSync(src)) throw new Error(`找不到 ${src}，先运行 npm run dist:mac`);

// Quit a running copy first so it isn't replaced underneath itself
const running = () => {
  try { execFileSync('/usr/bin/pgrep', ['-f', `${dest}/Contents/MacOS/`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (running()) {
  console.log('正在退出运行中的 Paper Reader…');
  execFileSync('/usr/bin/osascript', ['-e', 'quit app "Paper Reader"'], { stdio: 'ignore' });
  for (let i = 0; i < 20 && running(); i++) await new Promise(r => setTimeout(r, 500));
  if (running()) throw new Error('Paper Reader 没有退出，请手动退出后重试');
}

fs.rmSync(dest, { recursive: true, force: true });
execFileSync('/usr/bin/ditto', [src, dest], { stdio: 'inherit' });
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`已安装 Paper Reader ${version} → ${dest}`);
