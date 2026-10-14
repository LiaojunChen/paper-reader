import { useEffect, useState } from 'react';
import { api, fmtAuthors } from './api.js';

// ---- client cache of resolved references ----
const cache = new Map();   // resolved (or definitively not found) results
const inflight = new Map();
async function getJSON(url, tries = 2) {
  for (let i = 0; ; i++) {
    try { return await api.get(url); }
    catch (e) {
      // "Failed to fetch" = connection dropped / server restarting; retry once quietly
      if (i + 1 >= tries || !/fetch|network|load failed/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
}
export function fetchRef(itemId, n, { retry = false } = {}) {
  const k = `${itemId}:${n}`;
  if (!retry && cache.has(k)) return Promise.resolve(cache.get(k));
  if (!retry && inflight.has(k)) return inflight.get(k);
  const p = getJSON(`/api/items/${itemId}/refs/${n}${retry ? '?retry=1' : ''}`)
    .then(d => { if (d && !d.pending) cache.set(k, d); return d; })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
export function invalidateRef(itemId, n) { cache.delete(`${itemId}:${n}`); }
const friendly = m => /fetch|network/i.test(m) ? '连接本地服务失败，请稍后重试' : m;

// Shows the raw entry from the PDF immediately, then upgrades to online metadata
export function useRef_(itemId, n) {
  const k = `${itemId}:${n}`;
  const [state, set] = useState(() => cache.has(k) ? { loading: false, data: cache.get(k), error: null } : { loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    if (cache.has(k) && !nonce) { set({ loading: false, data: cache.get(k), error: null }); return; }
    set(s => ({ ...s, loading: true, error: null }));
    getJSON(`/api/items/${itemId}/refs/${n}?local=1`).then(d => live && !cache.has(k) && set(s => s.loading ? { ...s, data: d } : s)).catch(() => {});
    fetchRef(itemId, n, { retry: nonce > 0 })
      .then(d => live && set({ loading: !!d?.pending, data: d, error: d?.pending ? '在线检索较慢，稍后点重试' : null }))
      .catch(e => live && set(s => ({ loading: false, data: s.data, error: friendly(e.message) })));
    return () => { live = false; };
  }, [itemId, n, nonce, k]);
  return { ...state, retry: () => setNonce(x => x + 1) };
}

// Map an internal-link destination to a reference entry (works for author-year styles too)
export function refFromDest(refs, pageNum, x, y) {
  if (!refs?.length || !pageNum || y == null) return null;
  let best = null, bestScore = 1e9;
  for (const r of refs) {
    if (r.p !== pageNum || r.y == null) continue;
    let score = Math.abs(r.y - y + 6);
    if (x != null && Math.abs(r.x - x) > 120) score += 500;
    if (score < bestScore) { bestScore = score; best = r; }
  }
  return bestScore < 28 ? best : null;
}

const metaOf = d => d?.meta || {};
export const refTitle = d => metaOf(d).title || d?.title || '';

// Compact card for hover popover
export function CiteCard({ itemId, n, compact }) {
  const { loading, data, error, retry } = useRef_(itemId, n);
  if (!data) {
    return (
      <div className="cite-card"><span className="cite-n">[{n}]</span>
        <span className="muted">{loading ? '解析中…' : error || '参考文献列表中未找到该编号'}</span>
        {error && <button className="link" onClick={retry}>重试</button>}
      </div>
    );
  }
  const m = metaOf(data);
  return (
    <div className="cite-card">
      <div className="cite-head"><span className="cite-n">[{n}]</span>
        <span className="cite-title">{m.title || data.title || data.raw.slice(0, 120)}</span>
        {data.localId && <span className="badge ok" title="已在文库">已在库</span>}
      </div>
      {m.title ? <div className="cite-meta">{fmtAuthors(m.authors)}{m.year && ` · ${m.year}`}{m.venue && ` · ${m.venue}`}</div>
        : <div className="cite-meta muted">{data.raw.slice(0, 220)}</div>}
      {loading && <div className="cite-loading">正在在线检索详细信息…</div>}
      {!loading && error && <div className="cite-loading">{error} <button className="link" onClick={retry}>重试</button></div>}
      {!compact && m.abstract && <div className="cite-abs">{m.abstract.slice(0, 420)}{m.abstract.length > 420 && '…'}</div>}
    </div>
  );
}

// Full detail in the side panel
export function RefDetail({ itemId, n, onOpenLocal, onAnnotate, onImported }) {
  const { loading, data, error, retry } = useRef_(itemId, n);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  if (!data) {
    return (
      <div className="ref-detail"><div className="ref-n">[{n}]</div>
        <div className="muted">{loading ? '正在检索 OpenAlex / Crossref / arXiv…' : error || '未找到该编号的参考文献'}</div>
        {error && <button className="btn" style={{ marginTop: 8 }} onClick={retry}>重试</button>}
      </div>
    );
  }
  const m = metaOf(data);
  const arxiv = m.arxiv || data.arxiv;
  const doImport = async () => {
    setBusy('import'); setMsg('');
    try { const it = await api.post(`/api/items/${itemId}/refs/${n}/import`); setMsg(`已导入：${it.title}`); invalidateRef(itemId, n); onImported?.(it); }
    catch (e) { setMsg(`导入失败：${friendly(e.message)}`); }
    setBusy('');
  };
  const scholar = `https://scholar.google.com/scholar?q=${encodeURIComponent(refTitle(data))}`;
  return (
    <div className="ref-detail">
      <div className="ref-n">[{n}] {data.localId && <span className="badge ok">已在库</span>}</div>
      <div className="ref-title">{refTitle(data)}</div>
      {m.title && <div className="ref-meta">{fmtAuthors(m.authors, 6)}{m.year && ` · ${m.year}`}{m.venue && ` · ${m.venue}`}{m.citedBy != null && ` · 被引 ${m.citedBy}`}</div>}
      {m.abstract && <div className="ref-abs">{m.abstract}</div>}
      {loading && <div className="cite-loading">正在在线检索作者、摘要等信息…</div>}
      {!loading && !m.title && (
        <div className="muted small">
          {error || '未能在线匹配到元数据，下面是 PDF 里的原始条目。'}
          <button className="link" onClick={retry}>重新检索</button>
        </div>
      )}
      {!m.title && <div className="ref-raw">{data.raw}</div>}
      <div className="ref-actions">
        {data.localId ? <button className="btn primary" onClick={() => onOpenLocal?.(data.localId)}>在阅读器打开</button>
          : <button className="btn primary" disabled={!!busy} onClick={doImport}>{busy === 'import' ? '下载中…' : '下载到文库'}</button>}
        <button className="btn" onClick={() => onAnnotate?.(n, data)} title="以这条引用新建批注，可派给 AI">批注/派 AI</button>
        {arxiv && <a className="btn" href={`https://arxiv.org/abs/${arxiv}`} target="_blank" rel="noreferrer">arXiv</a>}
        {m.doi && <a className="btn" href={`https://doi.org/${m.doi}`} target="_blank" rel="noreferrer">DOI</a>}
        <a className="btn" href={scholar} target="_blank" rel="noreferrer">Scholar</a>
        <button className="btn ghost" onClick={() => navigator.clipboard.writeText(refTitle(data))}>复制标题</button>
      </div>
      {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
      <div className="ref-raw-toggle" onClick={() => setShowRaw(!showRaw)}>{showRaw ? '▾' : '▸'} 原始条目</div>
      {showRaw && <div className="ref-raw">{data.raw}</div>}
    </div>
  );
}

// Resolve arbitrary reference text (for PDFs whose reference list couldn't be parsed)
export function RawRefDetail({ raw }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.post('/api/resolve', { raw }).then(setData).catch(() => setData({ raw, title: '', meta: null })); }, [raw]);
  if (!data) return <div className="muted small">识别中…</div>;
  const m = data.meta || {};
  return (
    <div className="ref-detail">
      <div className="ref-title">{m.title || data.title || '未识别'}</div>
      {m.title && <div className="ref-meta">{fmtAuthors(m.authors, 6)}{m.year && ` · ${m.year}`}{m.venue && ` · ${m.venue}`}</div>}
      {m.abstract && <div className="ref-abs">{m.abstract}</div>}
      <div className="ref-actions">
        {m.arxiv && <a className="btn" href={`https://arxiv.org/abs/${m.arxiv}`} target="_blank" rel="noreferrer">arXiv</a>}
        {(m.arxiv || m.pdfUrl || m.title) && <button className="btn primary" onClick={() => api.post('/api/import', { query: m.arxiv || m.pdfUrl || m.title }).then(() => alert('已导入文库')).catch(e => alert(e.message))}>下载到文库</button>}
      </div>
    </div>
  );
}
