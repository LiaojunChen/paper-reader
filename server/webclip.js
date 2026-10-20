// Import a web page / blog post as a readable Markdown item.
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { unescapeMath } from '../shared/text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function turndown() {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  // Keep LaTeX that MathJax/KaTeX rendered into spans
  td.addRule('katex', {
    filter: n => n.classList?.contains('katex') || n.classList?.contains('MathJax'),
    replacement: (_c, n) => {
      const tex = n.querySelector('annotation[encoding="application/x-tex"]')?.textContent
        || n.querySelector('script[type^="math/tex"]')?.textContent || n.textContent;
      const display = n.classList.contains('katex-display') || /mode=display/.test(n.querySelector('script')?.getAttribute('type') || '');
      return display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    },
  });
  td.addRule('figure', {
    filter: 'figure',
    replacement: (_c, n) => {
      const img = n.querySelector('img');
      const cap = n.querySelector('figcaption')?.textContent?.trim();
      if (!img) return cap ? `\n\n*${cap}*\n\n` : '';
      return `\n\n![${cap || img.getAttribute('alt') || ''}](${img.getAttribute('src') || ''})\n\n`;
    },
  });
  td.remove(['script', 'style', 'noscript', 'iframe']);
  return td;
}

export async function fetchArticle(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`抓取失败 ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (/application\/pdf/.test(ct)) return { isPdf: true, buffer: Buffer.from(await r.arrayBuffer()) };
  const finalUrl = r.url || url;
  const html = await r.text();
  const { document } = parseHTML(html);
  // Resolve relative links/images against the final URL
  const base = document.createElement('base');
  base.setAttribute('href', finalUrl);
  document.head?.append(base);
  absolutize(document, finalUrl);
  const meta = n => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content') || '';
  const art = new Readability(document.cloneNode(true), { charThreshold: 200 }).parse();
  const md = art?.content ? unescapeMath(turndown().turndown(art.content)) : '';
  const title = (art?.title || meta('og:title') || document.title || finalUrl).replace(/\s+/g, ' ').trim();
  const authors = [art?.byline, meta('author'), meta('article:author')].filter(Boolean)
    .flatMap(s => String(s).split(/\s*(?:,|、|and |&)\s*/)).map(s => s.replace(/^(by|作者)[:：\s]*/i, '').trim())
    .filter(s => s && s.length < 60);
  const date = meta('article:published_time') || meta('datePublished') || meta('date')
    || document.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  return {
    isPdf: false, url: finalUrl, title,
    authors: [...new Set(authors)].slice(0, 6),
    year: (date.match(/(19|20)\d{2}/) || [''])[0],
    venue: new URL(finalUrl).hostname.replace(/^www\./, ''),
    abstract: (art?.excerpt || meta('og:description') || meta('description') || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    markdown: md.replace(/\n{3,}/g, '\n\n').trim(),
    readerable: !!art?.content || isProbablyReaderable(document),
  };
}

function absolutize(document, baseUrl) {
  for (const [sel, attr] of [['a[href]', 'href'], ['img[src]', 'src'], ['source[src]', 'src']]) {
    for (const el of document.querySelectorAll(sel)) {
      const v = el.getAttribute(attr);
      if (!v || /^(https?:|data:|mailto:|#)/.test(v)) continue;
      try { el.setAttribute(attr, new URL(v, baseUrl).href); } catch { /* leave as-is */ }
    }
  }
}
