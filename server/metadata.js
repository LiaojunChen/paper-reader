// Metadata lookup: arXiv API, Crossref, OpenAlex (all free, no key)
import { AsyncLocalStorage } from 'node:async_hooks';

// true inside background prefetch → lower queue priority, skip slow sources
const bgContext = new AsyncLocalStorage();
const UA = 'PaperReader/0.1 (local academic reader; mailto:paper-reader@example.com)';

// Per-host limiter: at most `conc` in flight and `gap` ms between starts.
// OpenAlex / Crossref answer bursts with 429, arXiv asks for ≤1 req / 3 s.
const LIMITS = {
  'api.openalex.org': { conc: 2, gap: 150 }, 'api.crossref.org': { conc: 2, gap: 150 },
  'export.arxiv.org': { conc: 1, gap: 3100 }, 'arxiv.org': { conc: 2, gap: 500 },
};
const hostState = new Map();
// Interactive lookups jump ahead of background prefetch in each host's queue
function schedule(host, fn, background) {
  const lim = LIMITS[host] || { conc: 4, gap: 0 };
  let st = hostState.get(host);
  if (!st) hostState.set(host, st = { active: 0, last: 0, queue: [] });
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject, background };
    if (background) st.queue.push(job);
    else { const i = st.queue.findIndex(j => j.background); i < 0 ? st.queue.push(job) : st.queue.splice(i, 0, job); }
    pump(st, lim);
  });
}
function pump(st, lim) {
  if (st.active >= lim.conc || !st.queue.length || st.timer) return;
  const wait = st.last + lim.gap - Date.now();
  if (wait > 0) { st.timer = setTimeout(() => { st.timer = null; pump(st, lim); }, wait); return; }
  const job = st.queue.shift();
  st.active++; st.last = Date.now();
  job.fn().then(job.resolve, job.reject).finally(() => { st.active--; pump(st, lim); });
  pump(st, lim);
}

// Hosts that told us to back off for a long time (e.g. OpenAlex daily budget exhausted) are skipped until then
const blockedUntil = new Map();
export const sourceStatus = () => Object.fromEntries([...blockedUntil].filter(([, t]) => t > Date.now()).map(([h, t]) => [h, new Date(t).toISOString()]));
let openalexKey = '';
export function configureSources({ openalexKey: k = '' } = {}) {
  if (k !== openalexKey) blockedUntil.delete('api.openalex.org');
  openalexKey = k;
}

async function get(url, { timeout = 10000, type = 'json', background = bgContext.getStore() } = {}) {
  const u = new URL(url);
  const host = u.host;
  if (blockedUntil.get(host) > Date.now()) throw new Error(`${host} 限流中`);
  if (host === 'api.openalex.org' && openalexKey) u.searchParams.set('api_key', openalexKey);
  for (let attempt = 0; ; attempt++) {
    const r = await schedule(host, () => fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) }), background);
    if (r.status === 429 || r.status >= 500) {
      const ra = +r.headers.get('retry-after');
      // Long back-off (budget exhausted): stop using this source for that period instead of waiting
      if (r.status === 429 && ra > 30) { blockedUntil.set(host, Date.now() + ra * 1000); throw new Error(`${host} 限流`); }
      if (attempt < 2) { await new Promise(res => setTimeout(res, (ra > 0 ? ra * 1000 : 700 * 2 ** attempt) + Math.random() * 300)); continue; }
    }
    if (!r.ok) throw new Error(`${r.status} ${host}`);
    return type === 'json' ? r.json() : type === 'buffer' ? Buffer.from(await r.arrayBuffer()) : r.text();
  }
}
const arxivGet = url => get(url, { type: 'text', timeout: 12000 });

// Resolve with the first non-null result; null if all fail/empty
function firstHit(promises) {
  return new Promise(resolve => {
    let left = promises.length;
    if (!left) return resolve(null);
    for (const p of promises) p.then(v => { if (v?.title) resolve(v); else if (!--left) resolve(null); }, () => { if (!--left) resolve(null); });
  });
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
export function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean)), B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---- arXiv ----
function parseArxivFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
  return entries.map(e => {
    const idUrl = tag(e, 'id');
    const arxiv = (idUrl.match(/abs\/([^v\s]+)(v\d+)?$/) || [])[1] || '';
    return {
      title: decodeXml(tag(e, 'title')),
      authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => decodeXml(m[1].trim())),
      abstract: decodeXml(tag(e, 'summary')),
      year: tag(e, 'published').slice(0, 4),
      venue: decodeXml(tag(e, 'arxiv:journal_ref')) || 'arXiv',
      doi: tag(e, 'arxiv:doi'),
      arxiv,
      url: arxiv ? `https://arxiv.org/abs/${arxiv}` : idUrl,
      pdfUrl: arxiv ? `https://arxiv.org/pdf/${arxiv}` : '',
    };
  }).filter(e => e.title && !/^Error$/i.test(e.title));
}
const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export async function arxivById(id) {
  // Background lookups go straight to the (unthrottled) abs page
  if (bgContext.getStore()) return arxivAbsPage(id);
  const xml = await arxivGet(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  return parseArxivFeed(xml)[0] || null;
}
export async function arxivSearch(title, max = 3) {
  const q = norm(title).split(' ').filter(w => w.length > 2).slice(0, 12).map(w => `ti:${w}`).join('+AND+');
  if (!q) return [];
  const xml = await arxivGet(`https://export.arxiv.org/api/query?search_query=${q}&max_results=${max}`);
  return parseArxivFeed(xml);
}

// arxiv.org/abs/<id> carries citation_* meta tags — fallback when export.arxiv.org is throttled
export async function arxivAbsPage(id) {
  const html = await get(`https://arxiv.org/abs/${encodeURIComponent(id)}`, { type: 'text', timeout: 12000 });
  const meta = name => [...html.matchAll(new RegExp(`<meta name="${name}" content="([^"]*)"`, 'g'))].map(m => decodeXml(m[1]));
  const title = meta('citation_title')[0];
  if (!title) return null;
  return {
    title, authors: meta('citation_author').map(a => a.includes(',') ? a.split(/,\s*/).reverse().join(' ') : a),
    abstract: (meta('citation_abstract')[0] || '').replace(/\s+/g, ' ').trim(),
    year: (meta('citation_date')[0] || meta('citation_online_date')[0] || '').slice(0, 4), venue: 'arXiv',
    doi: meta('citation_doi')[0] || '', arxiv: id, url: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`,
  };
}

// arxiv.org listing search (HTML). Not throttled like export.arxiv.org; used for preprints Crossref lacks.
const stripTags = s => decodeXml(s.replace(/<[^>]+>/g, '').replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim();
export async function arxivWebSearch(title, max = 5) {
  const q = norm(title).split(' ').filter(Boolean).slice(0, 14).join('+');
  if (!q) return [];
  const html = await get(`https://arxiv.org/search/?query=${q}&searchtype=title&abstracts=show&size=25&order=`, { type: 'text', timeout: 20000 });
  return html.split('<li class="arxiv-result">').slice(1, max + 1).map(it => {
    const arxiv = (it.match(/arxiv\.org\/abs\/([\w.\/-]+?)(v\d+)?"/) || [])[1] || '';
    const ttl = stripTags((it.match(/<p class="title[^"]*">([\s\S]*?)<\/p>/) || [])[1] || '');
    const authors = [...((it.match(/<p class="authors">([\s\S]*?)<\/p>/) || [])[1] || '').matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(m => decodeXml(m[1].trim()));
    const abs = stripTags(((it.match(/<span class="abstract-full[^>]*>([\s\S]*?)<a class="is-size-7"/) || [])[1]) || '');
    const sub = it.match(/Submitted<\/span>\s*\d*\s*\w+,?\s*((?:19|20)\d{2})/);
    return {
      title: ttl, authors, abstract: abs, year: sub?.[1] || (arxiv.match(/^(\d{2})\d{2}\./) ? '20' + arxiv.slice(0, 2) : ''),
      venue: 'arXiv', doi: '', arxiv, url: arxiv ? `https://arxiv.org/abs/${arxiv}` : '', pdfUrl: arxiv ? `https://arxiv.org/pdf/${arxiv}` : '',
    };
  }).filter(e => e.title);
}

// ---- Crossref ----
function fromCrossref(w) {
  return {
    _type: w.type,
    title: (w.title || [])[0] || '',
    authors: (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    year: String((w.issued?.['date-parts']?.[0]?.[0]) || (w.published?.['date-parts']?.[0]?.[0]) || ''),
    venue: (w['container-title'] || [])[0] || w.publisher || '',
    doi: w.DOI || '',
    abstract: (w.abstract || '').replace(/<[^>]+>/g, '').trim(),
    url: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : ''),
  };
}
export async function crossrefByDoi(doi) {
  const j = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  return fromCrossref(j.message);
}
export async function crossrefSearch(text, rows = 3) {
  const j = await get(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(text.slice(0, 300))}&rows=${rows}`);
  return (j.message?.items || []).map(fromCrossref);
}

// ---- OpenAlex ----
function invertAbstract(inv) {
  if (!inv) return '';
  const arr = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) arr[p] = w;
  return arr.filter(Boolean).join(' ');
}
function fromOpenAlex(w) {
  const arxiv = (JSON.stringify(w.locations || []).match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/) || [])[1] || '';
  return {
    title: w.title || w.display_name || '',
    authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
    year: String(w.publication_year || ''),
    venue: w.primary_location?.source?.display_name || '',
    doi: (w.doi || '').replace(/^https?:\/\/doi\.org\//, ''),
    abstract: invertAbstract(w.abstract_inverted_index),
    arxiv,
    url: w.doi || w.primary_location?.landing_page_url || w.id,
    pdfUrl: w.best_oa_location?.pdf_url || (arxiv ? `https://arxiv.org/pdf/${arxiv}` : ''),
    citedBy: w.cited_by_count,
  };
}
export async function openalexSearch(text, n = 3) {
  const j = await get(`https://api.openalex.org/works?search=${encodeURIComponent(text.slice(0, 250))}&per_page=${n}`);
  return (j.results || []).map(fromOpenAlex);
}

// Best-effort resolve of a paper given partial info (title / arxiv / doi / raw reference string)
// Exact IDs are tried first; title searches then run in parallel across sources (arXiv search is a slow last resort)
export function resolvePaper(q, opts = {}) {
  return bgContext.run(!!opts.background, () => resolvePaperInner(q, opts));
}
async function resolvePaperInner({ title = '', arxiv = '', doi = '', raw = '' }, opts) {
  const exact = [];
  if (arxiv) exact.push(arxivById(arxiv).catch(() => arxivAbsPage(arxiv)));
  if (doi) exact.push(crossrefByDoi(doi));
  const hit = await firstHit(exact);
  if (hit) return hit;
  const query = title || raw;
  if (!query) return null;
  // Crossref is full of reprint "book-chapter"s of famous papers — rank real venues above them
  const typeBonus = t => !t ? 0 : /journal-article|proceedings-article|posted-content/.test(t) ? 0.05 : /book-chapter|other|component/.test(t) ? -0.1 : 0;
  const pick = list => {
    const best = list.map(c => ({ c, s: (title ? similarity(c.title, title) : containsTitle(raw, c.title)) + typeBonus(c._type) }))
      .sort((a, b) => b.s - a.s)[0];
    return best && best.s >= (title ? 0.75 : 0.8) ? best.c : null;
  };
  // Crossref needs no key; OpenAlex adds abstracts/arXiv ids when its budget allows. arXiv title search is
  // only a last resort for interactive lookups (it rate-limits hard, so background prefetch skips it).
  // Prefer OpenAlex (abstracts, arXiv ids, citations); Crossref is the keyless fallback
  const oa = openalexSearch(query).then(pick);
  const cr = crossrefSearch(query).then(pick);
  // AI papers are mostly arXiv preprints without DOIs, which Crossref doesn't have
  const ax = title ? arxivWebSearch(title).then(pick) : Promise.resolve(null);
  let failed = 0;
  const safe = p => p.catch(() => { failed++; return null; });
  const best = await safe(oa) || await safe(ax) || await safe(cr);
  if (best) return best;
  if (title && !opts.background) { try { return pick(await arxivSearch(title)); } catch { failed++; } }
  // Distinguish "no match anywhere" from "sources unreachable" so the caller can retry later
  if (failed >= 2) throw Object.assign(new Error('在线数据源暂时不可用'), { transient: true });
  return null;
}

// Fraction of candidate title words that occur in the raw reference string
function containsTitle(raw, title) {
  const R = new Set(norm(raw).split(' ')), T = norm(title).split(' ').filter(Boolean);
  if (T.length < 2) return 0;
  return T.filter(w => R.has(w)).length / T.length;
}

// Extract a probable title from a raw reference string
export function titleFromReference(raw) {
  let s = raw.replace(/\s+/g, ' ');
  const q = s.match(/[“"]([^”"]{10,250})[”"]/);
  if (q) return q[1].replace(/[,.]$/, '');
  // Author-year style: "Smith, J. and Doe, K. (2023). Title. Venue" — the year must come within the first ~250 chars
  let m = s.match(/^.{3,250}?(?:\(\d{4}[a-z]?\)|\b(?:19|20)\d{2}[a-z]?)\.\s+(.{10,250}?)\.\s/);
  if (m && /,|\band\b|et al/.test(s.slice(0, s.indexOf(m[1]))) && !/^(In |Proceedings|Association|arXiv)/.test(m[1])) return m[1];
  // "A. Name, B. E. Name, and C. Name. Title. Venue" — split sentences, ignoring periods after initials
  const parts = [];
  let cur = '';
  // "Title, 2022. URL ..." — a trailing year belongs to the venue, not the title
  s = s.replace(/,\s*(19|20)\d{2}[a-z]?\.(\s|$)/, '.$2');
  const toks = s.split(' ');
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    cur += (cur ? ' ' : '') + tok;
    const bare = tok.replace(/^\(/, '');
    // "et al." ends the author list, so it is a sentence break; other abbreviations/initials are not
    const isEtAl = /^al\.$/.test(bare) && toks[i - 1] === 'et';
    if (/\.$/.test(tok) && (isEtAl || !/^([A-Z]|[A-Z]\.[A-Z]|al|et|vs|Proc|Conf|Int|Vol|pp|No)\.$/.test(bare))) { parts.push(cur.slice(0, -1)); cur = ''; }
  }
  if (cur) parts.push(cur);
  // "Wei, J., Wang, X., and Zhou, D. Title. Venue" (APA-ish)
  const apa = s.match(/^(?:(?:and\s+|&\s+)?[A-Z][\w'’-]+(?:\s[A-Z][\w'’-]+)?,\s(?:[A-Z]\.\s?-?)+,?\s)+(?:et al\.\s)?(.{10,250}?)\.\s/);
  if (apa) return apa[1];
  if (parts.length >= 2) {
    const i = parts.findIndex((p, k) => k > 0 && p.split(' ').length >= 1 && !/^(arXiv|In |CoRR|URL|doi|Proceedings|Advances|Science|Nature|\d)/.test(p));
    if (i > 0) return parts[i].replace(/[?]$/, '?');
  }
  return s.slice(0, 160);
}

export async function downloadPdf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('链接返回的不是 PDF');
  return buf;
}
