// Build the Windows installers and publish them as a GitHub Release, which the installed
// app's auto-updater picks up. Uses the `gh` CLI login, so no token has to be stored.
//
//   npm run release              → release the version in package.json
//   npm run release -- patch     → bump 0.2.0 → 0.2.1 first (also: minor / major / 1.2.3)
//   npm run release -- --notes "修复了…"
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const args = process.argv.slice(2);
const isWin = process.platform === 'win32';

function run(cmd, argv, opts = {}) {
  // .cmd shims (npm, npx) need a shell on Windows; arguments here are fixed, not user text
  const shell = isWin && /^(npm|npx)$/.test(cmd);
  return execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', shell, ...opts });
}

// ---- version ----
function bump(v, kind) {
  const [a, b, c] = v.split('.').map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  if (kind === 'patch') return `${a}.${b}.${c + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  throw new Error(`不认识的版本参数：${kind}`);
}
const kind = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--notes');
if (kind) {
  pkg.version = bump(pkg.version, kind);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`版本号 → ${pkg.version}`);
}
const version = pkg.version;
const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? args[notesIdx + 1] || '' : `Paper Reader ${version}`;

// ---- build ----
fs.rmSync(path.join(ROOT, 'release'), { recursive: true, force: true });
run('npm', ['run', 'dist']);

// ---- assets: the installer + its blockmap + latest.yml are what auto-update needs ----
const rel = path.join(ROOT, 'release');
const want = [`PaperReader-Setup-${version}.exe`, `PaperReader-Setup-${version}.exe.blockmap`, 'latest.yml', `PaperReader-${version}-portable.exe`];
const assets = want.map(f => path.join(rel, f)).filter(f => fs.existsSync(f));
const missing = want.filter(f => !fs.existsSync(path.join(rel, f)));
if (missing.length) console.warn('缺少文件：', missing.join(', '));
if (!assets.some(f => f.endsWith('latest.yml'))) throw new Error('没有生成 latest.yml，自动更新会找不到这个版本');

// ---- publish ----
const tag = `v${version}`;
const exists = (() => { try { run('gh', ['release', 'view', tag], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (exists) run('gh', ['release', 'upload', tag, ...assets, '--clobber']);
else run('gh', ['release', 'create', tag, ...assets, '--title', `Paper Reader ${version}`, '--notes', notes, '--target', 'main']);

console.log(`\n✓ 已发布 ${tag}。已安装的 Paper Reader 会在下次启动（或 4 小时内）检测到这个版本。`);
