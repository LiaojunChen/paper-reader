// Server-side PDF text extraction with pdf.js (legacy build works in Node)
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

// Returns { numPages, pages: [{ lines: [{ text, x, y, h }] }], info }
export async function extractPdf(file, maxPages = 60) {
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const meta = await doc.getMetadata().catch(() => null);
  const pages = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({ lines: groupLines(tc.items) });
    page.cleanup();
  }
  const info = meta?.info || {};
  const numPages = doc.numPages;
  await task.destroy();
  return { numPages, pages, info };
}

// Group text items into visual lines (keeps content-stream order, which follows columns in LaTeX PDFs)
function groupLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 0;
    if (cur && Math.abs(cur.y - y) < Math.max(2, h * 0.5) && x >= cur.xEnd - h * 2) {
      const gap = x - cur.xEnd;
      if (it.str && gap > h * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
      cur.text += it.str;
      cur.xEnd = x + (it.width || 0);
      cur.h = Math.max(cur.h, h);
    } else {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { text: it.str, x, y, h, xEnd: x + (it.width || 0) };
    }
    if (it.hasEOL && cur) { if (cur.text.trim()) lines.push(cur); cur = null; }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines.map(l => ({ text: l.text.replace(/\s+/g, ' ').trim(), x: l.x, y: l.y, h: l.h }));
}

export function fullText(pages) {
  return pages.map((p, i) => `\n\n--- Page ${i + 1} ---\n` + joinLines(p.lines.map(l => l.text))).join('');
}

// De-hyphenate line breaks
function joinLines(arr) {
  let out = '';
  for (const t of arr) {
    if (out.endsWith('-') && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += (out ? '\n' : '') + t;
  }
  return out;
}

// ---------- First-page heuristics ----------
export function guessFromFirstPage(pages, info = {}) {
  const lines = pages[0]?.lines || [];
  const all = pages.slice(0, 2).flatMap(p => p.lines.map(l => l.text)).join('\n');
  const arxivM = all.match(/arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i) || all.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
  const doiM = all.match(/\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/);
  // Title: largest-font lines in top part of first page (skipping arXiv side stamp)
  const cands = lines.filter(l => l.text.length > 3 && !/arXiv:\d/i.test(l.text) && !/^(preprint|under review|published)/i.test(l.text));
  let title = '';
  if (cands.length) {
    const maxH = Math.max(...cands.slice(0, 40).map(l => l.h));
    const idx = cands.findIndex(l => l.h >= maxH - 0.5);
    const parts = [];
    for (let i = idx; i < cands.length && i < idx + 4; i++) {
      if (Math.abs(cands[i].h - maxH) > 1) break;
      parts.push(cands[i].text);
    }
    title = parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  if ((!title || title.length < 8) && info.Title && info.Title.length > 8) title = info.Title;
  // Abstract
  let abstract = '';
  const absIdx = lines.findIndex(l => /^abstract\b/i.test(l.text));
  if (absIdx >= 0) {
    const buf = [lines[absIdx].text.replace(/^abstract[\s.:—-]*/i, '')];
    for (let i = absIdx + 1; i < lines.length && buf.join(' ').length < 2500; i++) {
      if (/^(1\.?|I\.?)\s+introduction/i.test(lines[i].text) || /^introduction$/i.test(lines[i].text)) break;
      buf.push(lines[i].text);
    }
    abstract = joinLines(buf).replace(/\n/g, ' ').trim();
  }
  return { title, arxiv: arxivM?.[1] || '', doi: doiM?.[1] || '', abstract };
}

// ---------- Reference list parsing ----------
// Returns [{ n, raw }] where n is 1-based citation number (or sequential for author-year style)
export function parseReferences(pages) {
  pages = stripRunningHeaders(pages);
  // Find last "References"/"Bibliography" heading
  let start = null;
  for (let p = pages.length - 1; p >= 0 && !start; p--) {
    const ls = pages[p].lines;
    for (let i = ls.length - 1; i >= 0; i--) {
      if (/^(\d+\.?\s*)?(references|bibliography|reference|参考文献)$/i.test(ls[i].text.trim())) { start = { p, i }; break; }
    }
  }
  if (!start) return [];
  const lines = [];
  for (let p = start.p; p < pages.length; p++) {
    const ls = pages[p].lines;
    for (let i = p === start.p ? start.i + 1 : 0; i < ls.length; i++) lines.push({ ...ls[i], p: p + 1 });
  }
  const numbered = lines.filter(l => /^\[\d+\]/.test(l.text)).length;
  const refs = [];
  if (numbered >= 3) {
    let cur = null;
    for (const l of lines) {
      const m = l.text.match(/^\[(\d+)\]\s*(.*)$/);
      if (m) { if (cur) refs.push(cur); cur = { n: +m[1], raw: m[2], p: l.p, x: l.x, y: l.y }; }
      else if (cur) {
        if (isSectionBreak(l.text) && refs.length > 3) { refs.push(cur); cur = null; break; }
        cur.raw = joinRaw(cur.raw, l.text);
      }
    }
    if (cur) refs.push(cur);
  } else {
    // "1. Author..." style or author-year with hanging indent
    // "1. Author" style only if such lines appear right at the start of the list and form a 1,2,3… sequence
    const head = lines.slice(0, 12).filter(l => /^\d{1,3}\.\s+[A-Z]/.test(l.text)).map(l => +l.text.match(/^\d+/)[0]);
    const dotNumbered = head.length >= 2 && head[0] === 1 && head[1] === 2 ? 3 : 0;
    let cur = null, seq = 0;
    // Per-column left margin: track minimal x among lines near current one
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k];
      if (isSectionBreak(l.text) && refs.length > 3) break;
      let isStart;
      if (dotNumbered >= 3) isStart = /^\d{1,3}\.\s+/.test(l.text);
      else {
        const prev = lines[k - 1];
        const colMin = Math.min(...lines.slice(Math.max(0, k - 6), k + 6).filter(o => Math.abs(o.x - l.x) < 60).map(o => o.x));
        const indented = l.x > colMin + 3;
        isStart = !cur || (!indented && (!prev || /[.)]$/.test(prev.text) || prev.x > l.x + 3 || Math.abs(prev.x - l.x) > 60));
      }
      if (isStart) {
        if (cur) refs.push(cur);
        const m = l.text.match(/^(\d{1,3})\.\s+(.*)$/);
        cur = dotNumbered >= 3 && m ? { n: +m[1], raw: m[2] } : { n: ++seq, raw: l.text };
        Object.assign(cur, { p: l.p, x: l.x, y: l.y });
      } else if (cur) cur.raw = joinRaw(cur.raw, l.text);
    }
    if (cur) refs.push(cur);
  }
  return refs.filter(r => r.raw.length > 10).map(r => ({ ...r, raw: r.raw.trim(), arxiv: r.raw.match(/(?:arXiv[:\s]*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5})/i)?.[1] || '' }));
}

function joinRaw(a, b) {
  if (a.endsWith('-') && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}
function isSectionBreak(t) {
  if (t.length > 80) return false;
  if (/^(appendix|appendices|supplementary)/i.test(t)) return true;
  // "A ADDITIONAL RESULTS", "A.1 GPT-3 Experiments", "B Implementation Details" (no commas => not an author list)
  return /^[A-H](\.\d+)*\.?\s+[A-Z0-9][\w-]*(\s+[\w-]+){0,8}$/.test(t) && !/[,;]/.test(t) && !/\b(and|et al)\b/.test(t);
}

// Lines repeated on many pages (running headers/footers) are noise
function stripRunningHeaders(pages) {
  const cnt = new Map();
  for (const p of pages) for (const t of new Set(p.lines.map(l => l.text))) cnt.set(t, (cnt.get(t) || 0) + 1);
  const min = Math.max(3, pages.length * 0.3);
  return pages.map(p => ({ lines: p.lines.filter(l => !(cnt.get(l.text) >= min) && !/^\d{1,3}$/.test(l.text)) }));
}
