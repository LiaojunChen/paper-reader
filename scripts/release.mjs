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

// ---- build (skipped when resuming an interrupted upload of the same version) ----
const relDir = path.join(ROOT, 'release');
const built = fs.existsSync(path.join(relDir, `PaperReader-Setup-${version}.exe`)) && fs.existsSync(path.join(relDir, 'latest.yml'))
  && fs.readFileSync(path.join(relDir, 'latest.yml'), 'utf8').includes(`version: ${version}`);
if (built && !args.includes('--rebuild')) console.log(`release/ 里已有 ${version} 的安装包，直接上传（加 --rebuild 强制重新打包）`);
else {
  fs.rmSync(relDir, { recursive: true, force: true });
  run('npm', ['run', 'dist']);
}

// ---- assets: the installer + its blockmap + latest.yml are what auto-update needs ----
const rel = path.join(ROOT, 'release');
const want = [`PaperReader-Setup-${version}.exe`, `PaperReader-Setup-${version}.exe.blockmap`, 'latest.yml', `PaperReader-${version}-portable.exe`];
const assets = want.map(f => path.join(rel, f)).filter(f => fs.existsSync(f));
const missing = want.filter(f => !fs.existsSync(path.join(rel, f)));
if (missing.length) console.warn('缺少文件：', missing.join(', '));
if (!assets.some(f => f.endsWith('latest.yml'))) throw new Error('没有生成 latest.yml，自动更新会找不到这个版本');

// ---- publish ----
// Uploads of ~125 MB files over a flaky connection can time out (HTTP 408), so: create the release
// as a draft, upload files one by one with retries, and only publish once every asset is present.
// Installed apps never see a draft, so a half-finished release can't break anyone's update.
const tag = `v${version}`;
const gh = (argv, opts) => run('gh', argv, opts);
const view = () => { try { return JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { cwd: ROOT, encoding: 'utf8' })); } catch { return null; } };
if (!view()) gh(['release', 'create', tag, '--draft', '--title', `Paper Reader ${version}`, '--notes', notes, '--target', 'main']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Upload big files first and latest.yml last: the update feed only points at the new version
// once the installer it references is already there
const order = [...assets].sort((a, b) => (a.endsWith('latest.yml') ? 1 : 0) - (b.endsWith('latest.yml') ? 1 : 0));
for (const file of order) {
  const name = path.basename(file), size = fs.statSync(file).size;
  for (let attempt = 1; ; attempt++) {
    const have = view()?.assets?.find(a => a.name === name);
    if (have && have.size === size) { console.log(`✓ ${name}`); break; }
    try { gh(['release', 'upload', tag, file, '--clobber']); }
    catch (e) {
      if (attempt >= 5) throw new Error(`上传 ${name} 失败 5 次，草稿已保留，网络好了以后重跑 npm run release 即可续传`);
      console.warn(`上传 ${name} 失败（第 ${attempt} 次），${attempt * 15} 秒后重试…`);
      await sleep(attempt * 15000);
    }
  }
}
if (view()?.isDraft) gh(['release', 'edit', tag, '--draft=false', '--latest']);

console.log(`\n✓ 已发布 ${tag}。已安装的 Paper Reader 会在下次启动（或 4 小时内）检测到这个版本。`);
