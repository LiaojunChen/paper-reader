import { useEffect, useRef, useState } from 'react';
import { api, stream, fmtAuthors } from './api.js';
import Markdown from './Markdown.jsx';

const QUICK = [
  ['一句话总结', '用一句话总结这篇论文的核心贡献。'],
  ['速读卡片', '按以下结构给出速读卡片：研究问题 / 核心方法（含关键公式或架构）/ 主要实验与结论 / 创新点 / 局限性 / 可借鉴之处。'],
  ['方法拆解', '详细拆解论文的方法部分：整体流程、各模块作用、训练目标与损失函数、关键超参数。'],
  ['实验设置', '整理实验设置：数据集、基线、评测指标、主要结果数字（表格形式）。'],
  ['批判性审稿', '以顶会审稿人的视角给出优点、缺点、疑问和改进建议。'],
  ['相关工作脉络', '梳理本文所处的研究脉络：它继承/对比了哪些关键前人工作（结合参考文献编号）？'],
];

export function ChatPanel({ item, onToNote }) {
  const key = `chat:${item.id}`;
  const [msgs, setMsgs] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const ac = useRef(null);
  const end = useRef(null);
  useEffect(() => { localStorage.setItem(key, JSON.stringify(msgs.slice(-40))); end.current?.scrollIntoView({ block: 'end' }); }, [msgs, key]);
  useEffect(() => () => ac.current?.abort(), []);

  async function send(text) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: 'user', content: text }];
    setMsgs([...next, { role: 'assistant', content: '' }]);
    setInput(''); setBusy(true);
    ac.current = new AbortController();
    try {
      await stream(`/api/items/${item.id}/chat`, { messages: next }, out => setMsgs([...next, { role: 'assistant', content: out }]), ac.current.signal);
    } catch (e) { if (e.name !== 'AbortError') setMsgs([...next, { role: 'assistant', content: `⚠️ ${e.message}` }]); }
    setBusy(false);
  }
  return (
    <div className="chat-panel">
      <div className="chat-msgs">
        {!msgs.length && (
          <div className="quick">
            <div className="muted small">基于全文与 LLM 对话（使用设置中的 LLM API）。复杂检索任务请用批注「派给 AI」。</div>
            {QUICK.map(([l, p]) => <button key={l} className="chip" onClick={() => send(p)}>{l}</button>)}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content || '…'} /> : <div className="user-text">{m.content}</div>}
            {m.role === 'assistant' && m.content && <div className="msg-act"><button className="link" onClick={() => onToNote(m.content)}>→笔记</button><button className="link" onClick={() => navigator.clipboard.writeText(m.content)}>复制</button></div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea value={input} placeholder="问问这篇论文…（Enter 发送，Shift+Enter 换行）" onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }} />
        <div className="row">
          {msgs.length > 0 && <button className="link" onClick={() => setMsgs([])}>清空</button>}
          <span className="spacer" />
          {busy ? <button className="btn" onClick={() => ac.current?.abort()}>停止</button> : <button className="btn primary" onClick={() => send(input)}>发送</button>}
        </div>
      </div>
    </div>
  );
}

export function InfoPanel({ item, onChange }) {
  const [f, setF] = useState(item);
  const [busy, setBusy] = useState(false);
  const [tag, setTag] = useState('');
  useEffect(() => setF(item), [item]);
  const save = async patch => onChange(await api.patch(`/api/items/${item.id}`, patch));
  const field = (k, label, multiline) => (
    <label className="info-field"><span>{label}</span>
      {multiline ? <textarea value={f[k] || ''} onChange={e => setF({ ...f, [k]: e.target.value })} onBlur={() => f[k] !== item[k] && save({ [k]: f[k] })} />
        : <input value={f[k] || ''} onChange={e => setF({ ...f, [k]: e.target.value })} onBlur={() => f[k] !== item[k] && save({ [k]: f[k] })} />}
    </label>
  );
  const status = { ok: '已在线匹配', guessed: '仅从 PDF 推断（未匹配到在线记录）', indexing: '索引中…', pending: '等待索引', error: '解析失败' }[item.meta_status];
  return (
    <div className="info-panel">
      <div className={`meta-status ${item.meta_status}`}>{status}</div>
      {field('title', '标题', true)}
      <label className="info-field"><span>作者</span>
        <textarea value={(f.authors || []).join('; ')} onChange={e => setF({ ...f, authors: e.target.value.split(/\s*;\s*/) })}
          onBlur={() => save({ authors: (f.authors || []).map(s => s.trim()).filter(Boolean) })} />
      </label>
      <div className="info-row">{field('year', '年份')}{field('venue', '发表于')}</div>
      <div className="info-row">{field('arxiv', 'arXiv')}{field('doi', 'DOI')}</div>
      {field('url', 'URL')}
      <label className="info-field"><span>标签</span>
        <div className="tags">
          {(item.tags || []).map(t => <span key={t} className="tag">{t}<button onClick={() => save({ tags: item.tags.filter(x => x !== t) })}>×</button></span>)}
          <input value={tag} placeholder="添加标签，回车" onChange={e => setTag(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && tag.trim()) { save({ tags: [...new Set([...(item.tags || []), tag.trim()])] }); setTag(''); } }} />
        </div>
      </label>
      {field('abstract', '摘要', true)}
      <div className="info-actions">
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { onChange(await api.post(`/api/items/${item.id}/reindex`, { arxiv: f.arxiv, title: f.title })); } finally { setBusy(false); } }}>
          {busy ? '重新索引中…' : '按当前标题/arXiv 重新匹配'}</button>
        <button className="btn" onClick={async () => navigator.clipboard.writeText(await api.get(`/api/items/${item.id}/bibtex`))}>复制 BibTeX</button>
        {item.url && <a className="btn" href={item.url} target="_blank" rel="noreferrer">打开主页</a>}
        <a className="btn" href={`https://scholar.google.com/scholar?q=${encodeURIComponent(item.title)}`} target="_blank" rel="noreferrer">Scholar</a>
        {item.arxiv && <a className="btn" href={`https://www.alphaxiv.org/abs/${item.arxiv}`} target="_blank" rel="noreferrer">alphaXiv</a>}
        {item.arxiv && <a className="btn" href={`https://paperswithcode.com/paper/arxiv:${item.arxiv}`} target="_blank" rel="noreferrer">代码</a>}
      </div>
      <div className="muted tiny">解析到 {item.refs?.length || 0} 条参考文献 · {item.num_pages} 页 · 原文件名 {item.orig_name}</div>
    </div>
  );
}

export function OutlinePanel({ outline, pdf, numPages, onClose, isWeb, width }) {
  return (
    <aside className="outline-panel" style={width ? { width } : undefined}>
      <div className="panel-head"><b>目录</b><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></div>
      <div className="outline-body">
        {isWeb ? (
          outline.length
            ? <ul className="outline-tree">{outline.map((h, i) => (
                <li key={i}><button style={{ paddingLeft: `${0.5 + (h.level - 1) * 0.8}rem` }} onClick={() => pdf.current?.goToHeading(h)}>{h.title}</button></li>
              ))}</ul>
            : <div className="muted small pad">这篇文章没有小标题。</div>
        ) : outline.length ? <OutlineTree items={outline} pdf={pdf} /> : (
          <div className="muted small pad">此 PDF 没有内嵌目录。
            <div className="page-grid">{Array.from({ length: numPages }, (_, i) => <button key={i} onClick={() => pdf.current?.goToPage(i + 1)}>{i + 1}</button>)}</div>
          </div>
        )}
      </div>
    </aside>
  );
}
function OutlineTree({ items, pdf, depth = 0 }) {
  return (
    <ul className="outline-tree">
      {items.map((o, i) => (
        <li key={i}>
          <button style={{ paddingLeft: 8 + depth * 12 }} onClick={() => o.dest && pdf.current?.goToDest(o.dest)}>{o.title}</button>
          {o.items?.length > 0 && depth < 3 && <OutlineTree items={o.items} pdf={pdf} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}
