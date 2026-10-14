export const CLIENT_ID = Math.random().toString(36).slice(2);

async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body instanceof FormData ? { 'x-client-id': CLIENT_ID } : { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error || data || r.statusText);
  return data;
}
export const api = {
  get: u => req('GET', u),
  post: (u, b) => req('POST', u, b ?? {}),
  patch: (u, b) => req('PATCH', u, b),
  put: (u, b) => req('PUT', u, b),
  del: u => req('DELETE', u),
};

// Streamed text endpoint; calls onText with accumulated text
export async function stream(url, body, onText, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(await r.text());
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    onText(acc);
  }
  return acc;
}

// Shared SSE subscription
const listeners = new Set();
let es;
export function subscribe(fn) {
  listeners.add(fn);
  if (!es) {
    es = new EventSource('/api/events');
    es.onmessage = e => { const m = JSON.parse(e.data); for (const l of listeners) l(m); };
  }
  return () => listeners.delete(fn);
}

export const COLORS = {
  yellow: { name: '黄', hex: '#ffd400' },
  red: { name: '红', hex: '#ff6666' },
  green: { name: '绿', hex: '#5fb236' },
  blue: { name: '蓝', hex: '#2ea8e5' },
  purple: { name: '紫', hex: '#a28ae5' },
  magenta: { name: '洋红', hex: '#e56eee' },
  orange: { name: '橙', hex: '#f19837' },
  gray: { name: '灰', hex: '#aaaaaa' },
};
export const COLOR_LABEL_DEFAULT = { yellow: '重点', red: '质疑', green: '方法', blue: '定义', purple: '待查', magenta: '实验', orange: '结论', gray: '其他' };

export const fmtAuthors = (a = [], n = 3) => !a.length ? '' : a.length <= n ? a.join(', ') : `${a.slice(0, n).join(', ')} 等`;
export const fmtDate = t => new Date(t).toLocaleDateString('zh-CN');
