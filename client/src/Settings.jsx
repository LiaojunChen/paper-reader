import { useState } from 'react';
import { api, COLORS, COLOR_LABEL_DEFAULT } from './api.js';
import { setPresetCache } from './AgentComposer.jsx';

const PRESETS = {
  openai: { llmProvider: 'openai', llmBaseUrl: 'https://api.openai.com/v1', llmModel: 'gpt-4o-mini' },
  deepseek: { llmProvider: 'openai', llmBaseUrl: 'https://api.deepseek.com/v1', llmModel: 'deepseek-chat' },
  qwen: { llmProvider: 'openai', llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', llmModel: 'qwen-plus' },
  moonshot: { llmProvider: 'openai', llmBaseUrl: 'https://api.moonshot.cn/v1', llmModel: 'kimi-latest' },
  anthropic: { llmProvider: 'anthropic', llmBaseUrl: 'https://api.anthropic.com', llmModel: 'claude-sonnet-5-5' },
  ollama: { llmProvider: 'openai', llmBaseUrl: 'http://localhost:11434/v1', llmModel: 'qwen2.5:7b' },
};

export default function Settings({ settings, onClose, onSaved }) {
  const [s, setS] = useState({ colorLabels: COLOR_LABEL_DEFAULT, ...settings, uiScale: +localStorage.getItem('uiScale') || 1 });
  const [testing, setTesting] = useState('');
  const set = (k, v) => setS(x => ({ ...x, [k]: v }));
  const save = async () => {
    localStorage.setItem('uiScale', s.uiScale || 1);
    const body = { ...s, agentPresets: (s.agentPresets || []).filter(p => p.label?.trim() && p.text?.trim()) };
    const saved = await api.put('/api/settings', body);
    setPresetCache(saved.agentPresets);
    onSaved(saved);
  };
  const cancel = () => { document.documentElement.style.setProperty('--ui-scale', +localStorage.getItem('uiScale') || 1); onClose(); };
  const test = async () => {
    await api.put('/api/settings', s);
    setTesting('测试中…');
    const r = await fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Attention is all you need.' }) });
    setTesting(await r.text());
  };
  const inp = (k, label, props = {}) => (
    <label className="info-field"><span>{label}</span><input value={s[k] ?? ''} onChange={e => set(k, e.target.value)} {...props} /></label>
  );
  return (
    <div className="modal-mask" onMouseDown={cancel}>
      <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
        <h3>设置</h3>
        <div className="set-sec">LLM（划词翻译 / 解释 / AI 对话）</div>
        <div className="row wrap">
          {Object.keys(PRESETS).map(k => <button key={k} className="chip" onClick={() => setS(x => ({ ...x, ...PRESETS[k] }))}>{k}</button>)}
        </div>
        <label className="info-field"><span>协议</span>
          <select value={s.llmProvider} onChange={e => set('llmProvider', e.target.value)}>
            <option value="openai">OpenAI 兼容（OpenAI / DeepSeek / 通义 / Kimi / Ollama …）</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
        {inp('llmBaseUrl', 'Base URL')}
        {inp('llmApiKey', 'API Key', { type: 'password', placeholder: '只保存在本地数据库' })}
        {inp('llmModel', '模型')}
        {inp('targetLang', '翻译目标语言')}
        <div className="row"><button className="btn" onClick={test}>测试连接</button><span className="small">{testing}</span></div>

        <div className="set-sec">笔记库（Obsidian 兼容）</div>
        <div className="muted small">左侧的文件夹和笔记都是这个目录下真实的文件夹和 .md 文件，可以直接用 Obsidian 打开同一个目录。论文 PDF、元数据和批注仍存在数据库里。改到一个已有的 Obsidian 库也可以。</div>
        {inp('vaultDir', '笔记库路径')}

        <div className="set-sec">文献元数据</div>
        <div className="muted small">引用信息来自 OpenAlex（含摘要）和 Crossref。OpenAlex 不填 Key 时与同一出口 IP 的所有人共享每日免费额度，额度用完后只能用 Crossref（没有摘要）。可以在 openalex.org 免费申请 Key。</div>
        {inp('openalexKey', 'OpenAlex API Key（可选）', { type: 'password' })}

        <div className="set-sec">AI 代理（批注「派给 AI」）</div>
        <div className="muted small">每个任务会在后台启动一个无头 Claude Code 进程（claude -p），只开放 Read/Grep/Glob/WebSearch/WebFetch 工具，工作目录为该论文的独立文件夹（含全文与参考文献）。需本机已安装并登录 Claude Code。</div>
        {inp('agentCommand', '命令', { placeholder: 'claude' })}
        <div className="info-row">
          {inp('agentModel', '模型（留空=默认，可填 sonnet / opus / haiku）')}
          {inp('agentMaxBudget', '单任务预算上限 USD')}
        </div>
        <div className="info-field"><span>快捷指令（派给 AI 时一键发送；也可以在批注的指令框里点 ⚙ 管理）</span>
          {(s.agentPresets || []).map((p, i) => (
            <div key={i} className="ac-preset-row">
              <input className="ac-label" value={p.label} maxLength={12} placeholder="名称"
                onChange={e => set('agentPresets', s.agentPresets.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
              <textarea className="ac-ptext" rows={2} value={p.text} placeholder="发给 AI 的指令"
                onChange={e => set('agentPresets', s.agentPresets.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} />
              <button className="icon" title="删除" onClick={() => set('agentPresets', s.agentPresets.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="link" onClick={() => set('agentPresets', [...(s.agentPresets || []), { label: '新指令', text: '' }])}>＋ 添加快捷指令</button></div>
        </div>

        <div className="set-sec">界面</div>
        <label className="info-field"><span>界面缩放 {Math.round((s.uiScale || 1) * 100)}%</span>
          <div className="scale-row">
            <input type="range" min="0.8" max="1.6" step="0.05" value={s.uiScale || 1}
              onChange={e => { const v = +e.target.value; set('uiScale', v); document.documentElement.style.setProperty('--ui-scale', v); }} />
            <button className="btn ghost" onClick={() => { set('uiScale', 1); document.documentElement.style.setProperty('--ui-scale', 1); }}>重置</button>
          </div>
        </label>
        <div className="muted small">也可以用 Ctrl + 滚轮 / Ctrl +/- 调整。</div>

        <div className="set-sec">高亮颜色含义</div>
        <div className="color-labels">
          {Object.entries(COLORS).map(([k, c]) => (
            <label key={k}><i style={{ background: c.hex }} />
              <input value={s.colorLabels?.[k] ?? ''} onChange={e => set('colorLabels', { ...s.colorLabels, [k]: e.target.value })} /></label>
          ))}
        </div>
        <div className="row"><span className="spacer" /><button className="btn" onClick={cancel}>取消</button><button className="btn primary" onClick={save}>保存</button></div>
      </div>
    </div>
  );
}
