// "派给 AI" — runs a headless Claude Code process per annotation task.
// The agent gets read-only + web tools in a per-paper workspace (paper fulltext + parsed references),
// answers into the annotation, and may request papers to be imported into the library.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, decode, getSettings, update, DATA_DIR, TEXT_DIR } from './db.js';

const running = new Map(); // annotationId -> child process
let broadcast = () => {};
export function setBroadcaster(fn) { broadcast = fn; }

const SYSTEM = `你是嵌入在论文阅读器里的科研助手。用户在阅读论文时写了一条批注并把它派给你处理。
工作目录里有：
- paper.txt：当前论文全文（按页分隔）
- references.json：当前论文解析出的参考文献列表 [{n, raw, arxiv, title?}]，n 为正文中引用编号
- task.json：批注信息（高亮原文、用户的批注/问题、涉及的引用编号）
要求：
0. task.json 里的 instruction 是用户这次给你的具体指令，优先按它执行；user_comment 和 highlighted_text 是背景。instruction 为空时，把 user_comment 当作任务。有 previous_ai_reply 时说明是追问，在上次回答的基础上补充，不要整段重复。
1. 先读 task.json，必要时读 paper.txt / references.json 定位上下文。
2. 涉及被引论文时，用 WebSearch / WebFetch 检索（优先 arxiv.org/abs、官方页面、GitHub），读到实质内容再回答，不要凭空编造。
3. 用中文回答，Markdown 格式，简洁有信息量，关键结论附来源链接。
4. 如果用户要求下载/导入/收藏某篇论文，在结果的 imports 字段中给出（尽量提供 arXiv ID 或可直接下载的 PDF 链接）。
5. 最终只输出一个 JSON 代码块（\`\`\`json ... \`\`\`），格式：
{"reply": "Markdown 回答", "imports": [{"title": "...", "arxiv": "2308.08155", "pdfUrl": "https://..."}]}
没有要导入的论文时 imports 为空数组。`;

function workspaceFor(item) {
  const dir = path.join(DATA_DIR, 'agent', item.id);
  fs.mkdirSync(dir, { recursive: true });
  const txt = path.join(TEXT_DIR, `${item.id}.txt`);
  if (fs.existsSync(txt)) fs.copyFileSync(txt, path.join(dir, 'paper.txt'));
  fs.writeFileSync(path.join(dir, 'references.json'), JSON.stringify(item.refs || [], null, 1));
  return dir;
}

function cleanEnv() {
  const env = { ...process.env };
  // Don't let the child think it is nested inside another Claude Code session
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SESSION|CHILD|MESSAGING|ENTRYPOINT)|^CLAUDECODE$|^CLAUDE_PID$/.test(k)) delete env[k];
  return env;
}

export function isRunning(id) { return running.has(id); }

// On Windows child.kill() only ends the shim, leaving the real agent running; kill the whole tree
function killTree(child) {
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  else child.kill();
}

export function cancelTask(annId) {
  const p = running.get(annId);
  if (p) { killTree(p); running.delete(annId); }
  update('annotations', annId, { ai_status: 'cancelled' }, ['ai_status']);
  emitAnn(annId);
}

function emitAnn(id) {
  const a = decode(db.prepare('SELECT * FROM annotations WHERE id = ?').get(id));
  if (a) broadcast({ type: 'annotation', annotation: a });
}

// importer: async ({title, arxiv, pdfUrl}) => item  (provided by index.js)
export function runTask(annId, { importer, instruction = '' } = {}) {
  if (running.has(annId)) return;
  const ann = decode(db.prepare('SELECT * FROM annotations WHERE id = ?').get(annId));
  if (!ann) throw new Error('批注不存在');
  const item = decode(db.prepare('SELECT * FROM items WHERE id = ?').get(ann.item_id));
  const s = getSettings();
  const cwd = workspaceFor(item);
  instruction = String(instruction || '').slice(0, 4000);
  const refNums = [...new Set([...(ann.text + ' ' + ann.comment + ' ' + instruction).matchAll(/\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g)]
    .flatMap(m => expandCite(m[1])))];
  if (ann.ref_index) refNums.unshift(ann.ref_index);
  const task = {
    paper: { title: item.title, authors: item.authors, year: item.year, arxiv: item.arxiv },
    page: ann.page,
    highlighted_text: ann.text,
    user_comment: ann.comment,
    instruction: instruction || '',
    previous_ai_reply: ann.ai_reply || undefined,
    cited_references: refNums.map(n => (item.refs || []).find(r => r.n === n)).filter(Boolean),
  };
  fs.writeFileSync(path.join(cwd, 'task.json'), JSON.stringify(task, null, 1));

  // Instructions go through stdin so the command line stays shell-safe (Windows .cmd shims need shell:true)
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch',
    '--permission-mode', 'dontAsk', '--no-session-persistence'];
  // Validated because .cmd shims are launched through a shell
  if (s.agentModel && /^[\w.:\-\[\]]+$/.test(s.agentModel)) args.push('--model', s.agentModel);
  if (s.agentMaxBudget && /^\d+(\.\d+)?$/.test(String(s.agentMaxBudget))) args.push('--max-budget-usd', String(s.agentMaxBudget));

  const log = [];
  const pushLog = line => {
    log.push(line);
    update('annotations', annId, { ai_log: log.slice(-40).join('\n') }, ['ai_log']);
    emitAnn(annId);
  };
  update('annotations', annId, { ai_status: 'running', ai_log: '启动 Claude Code…', ai_instruction: instruction || '' }, ['ai_status', 'ai_log', 'ai_instruction']);
  emitAnn(annId);

  const cmd = s.agentCommand || 'claude';
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  let child;
  try {
    child = spawn(cmd, args, { cwd, env: cleanEnv(), windowsHide: true, shell: useShell });
  } catch (e) {
    update('annotations', annId, { ai_status: 'error', ai_log: String(e) }, ['ai_status', 'ai_log']);
    return emitAnn(annId);
  }
  running.set(annId, child);
  const killer = setTimeout(() => {
    if (running.get(annId) !== child) return;
    running.delete(annId);
    killTree(child);
    update('annotations', annId, { ai_status: 'error', ai_log: log.concat('⏱ 超时（15 分钟）已终止', stderr.slice(-500)).join('\n') }, ['ai_status', 'ai_log']);
    emitAnn(annId);
  }, 15 * 60 * 1000);
  child.on('exit', () => clearTimeout(killer));
  child.stdin.end(`${SYSTEM}\n\n现在请处理 task.json 中的批注任务。`);

  let buf = '', finalText = '', stderr = '';
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'system' && ev.subtype === 'init') pushLog(`✅ 已连接（${ev.model || 'agent'}），思考中…`);
      else if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'tool_use') pushLog(`🔧 ${c.name} ${summarizeInput(c.input)}`);
          else if (c.type === 'text' && c.text.trim()) { finalText = c.text; }
        }
      } else if (ev.type === 'result') {
        if (ev.result) finalText = ev.result;
        if (ev.is_error) pushLog(`❌ ${ev.subtype || 'error'} ${ev.result || ''}`);
      }
    }
  });
  child.stderr.on('data', d => { stderr += d.toString('utf8'); });
  child.on('error', e => {
    running.delete(annId);
    update('annotations', annId, { ai_status: 'error', ai_log: `无法启动 agent（${cmd}）：${e.message}\n请确认已安装 Claude Code 并登录；Windows 下若只有 npm 安装的 claude.cmd，请在设置里把命令改成 claude.cmd。` }, ['ai_status', 'ai_log']);
    emitAnn(annId);
  });
  child.on('close', async code => {
    if (running.get(annId) !== child) return; // cancelled or errored
    // stays in `running` until imports finish so status isn't reported as stale
    const parsed = parseFinal(finalText);
    const finish = () => running.get(annId) === child && running.delete(annId);
    if (!parsed.reply) {
      finish();
      update('annotations', annId, { ai_status: 'error', ai_log: log.concat(`进程退出 code=${code}`, stderr.slice(-800)).join('\n') }, ['ai_status', 'ai_log']);
      return emitAnn(annId);
    }
    let reply = parsed.reply;
    const notes = [];
    for (const imp of parsed.imports || []) {
      try {
        pushLog(`📥 导入 ${imp.title || imp.arxiv || imp.pdfUrl}`);
        const it = await importer(imp, item);
        notes.push(`- ✅ 已导入文库：**${it.title}**`);
      } catch (e) { notes.push(`- ⚠️ 导入失败（${imp.title || imp.arxiv || imp.pdfUrl}）：${e.message}`); }
    }
    if (notes.length) reply += `\n\n---\n${notes.join('\n')}`;
    if (running.get(annId) !== child) return; // cancelled during import
    finish();
    update('annotations', annId, { ai_status: 'done', ai_reply: reply }, ['ai_status', 'ai_reply']);
    emitAnn(annId);
  });
}

function summarizeInput(inp = {}) {
  const v = inp.query || inp.url || inp.file_path || inp.pattern || inp.prompt || '';
  return String(v).slice(0, 120);
}

function parseFinal(text) {
  if (!text) return {};
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const b of [...blocks.reverse(), text]) {
    try {
      const j = JSON.parse(b.trim());
      if (j && typeof j.reply === 'string') return j;
    } catch { /* not JSON */ }
  }
  // Fallback: treat whole text as the reply
  return { reply: text.trim(), imports: [] };
}

export function expandCite(s) {
  const out = [];
  for (const part of s.split(/\s*,\s*/)) {
    const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) { const a = +m[1], b = +m[2]; if (b >= a && b - a < 50) for (let k = a; k <= b; k++) out.push(k); }
    else if (/^\d+$/.test(part)) out.push(+part);
  }
  return out;
}
