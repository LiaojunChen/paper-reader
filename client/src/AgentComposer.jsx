import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Instructions sent with 派给 AI. Presets are shared app-wide (stored in settings) and editable here.
let presetCache = null;
const presetListeners = new Set();
// Settings dialog saved new presets: refresh every open composer
export function setPresetCache(list) { presetCache = list || []; presetListeners.forEach(f => f(presetCache)); }
async function loadPresets() {
  if (!presetCache) presetCache = (await api.get('/api/settings')).agentPresets || [];
  return presetCache;
}
async function savePresets(list) {
  presetCache = list;
  presetListeners.forEach(f => f(list));
  await api.put('/api/settings', { agentPresets: list });
}
function usePresets() {
  const [list, setList] = useState(presetCache || []);
  useEffect(() => {
    let live = true;
    loadPresets().then(l => live && setList(l));
    presetListeners.add(setList);
    return () => { live = false; presetListeners.delete(setList); };
  }, []);
  return list;
}

// Box under a sticker: type an instruction (or pick a preset) and send it to the agent.
// Empty instruction = use the annotation's comment as the task, like before.
export default function AgentComposer({ annotation, onSend, onClose, followUp }) {
  const presets = usePresets();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const ta = useRef(null);
  useEffect(() => { ta.current?.focus(); }, []);
  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = (t = text) => { onSend(t.trim()); setText(''); onClose?.(); };
  const hasComment = !!annotation.comment?.trim();
  const placeholder = followUp
    ? '追问或补充要求，例如：再对比一下 CAMEL 的做法'
    : hasComment ? '给 AI 的具体指令（可选；留空则按批注内容处理）' : '告诉 AI 要做什么，例如：这个方法和 [12] 有什么区别？';

  if (editing) return <PresetEditor presets={presets} onDone={() => setEditing(false)} />;
  return (
    <div className="agent-composer" onClick={e => e.stopPropagation()}>
      <div className="ac-presets">
        {presets.map((p, i) => (
          <button key={i} className="chip" title={p.text}
            // Click: send right away. Shift+click: put it in the box to edit first
            onClick={e => e.shiftKey ? setText(t => (t ? t + '\n' : '') + p.text) : send(p.text)}>{p.label}</button>
        ))}
        <button className="chip ghost" title="管理快捷指令" onClick={() => setEditing(true)}>⚙</button>
      </div>
      <textarea ref={ta} className="ac-input" value={text} placeholder={placeholder} rows={2}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim() || hasComment) send(); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
        }} />
      <div className="ac-row">
        <span className="muted tiny">Enter 发送 · Shift+Enter 换行 · Shift+点快捷指令可先编辑</span>
        <span className="spacer" />
        {text.trim() && <button className="link" title="把这条指令存为快捷指令" onClick={async () => {
          const label = prompt('快捷指令名称', text.trim().slice(0, 8));
          if (label) await savePresets([...presets, { label: label.slice(0, 12), text: text.trim() }]);
        }}>存为快捷</button>}
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!text.trim() && !hasComment} onClick={() => send()}>🤖 发送</button>
      </div>
    </div>
  );
}

function PresetEditor({ presets, onDone }) {
  const [list, setList] = useState(presets.map(p => ({ ...p })));
  const set = (i, k, v) => setList(l => l.map((p, j) => j === i ? { ...p, [k]: v } : p));
  const move = (i, d) => setList(l => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <div className="agent-composer" onClick={e => e.stopPropagation()}>
      <div className="ac-title">快捷指令</div>
      {list.map((p, i) => (
        <div key={i} className="ac-preset-row">
          <input className="ac-label" value={p.label} maxLength={12} placeholder="名称" onChange={e => set(i, 'label', e.target.value)} />
          <textarea className="ac-ptext" value={p.text} rows={2} placeholder="发给 AI 的指令" onChange={e => set(i, 'text', e.target.value)} />
          <div className="ac-ops">
            <button className="icon" title="上移" onClick={() => move(i, -1)}>↑</button>
            <button className="icon" title="下移" onClick={() => move(i, 1)}>↓</button>
            <button className="icon" title="删除" onClick={() => setList(l => l.filter((_, j) => j !== i))}>✕</button>
          </div>
        </div>
      ))}
      <div className="ac-row">
        <button className="link" onClick={() => setList(l => [...l, { label: '新指令', text: '' }])}>＋ 添加</button>
        <span className="spacer" />
        <button className="btn" onClick={onDone}>取消</button>
        <button className="btn primary" onClick={async () => { await savePresets(list.filter(p => p.label.trim() && p.text.trim())); onDone(); }}>保存</button>
      </div>
    </div>
  );
}
