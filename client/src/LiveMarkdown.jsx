import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from './Markdown.jsx';

// Obsidian-style live editing: the document renders as formatted blocks; clicking a block
// swaps just that block for a raw-Markdown textarea. Blocks are separated by blank lines.
// `editIdx` may equal blocks.length — an empty block being typed that isn't stored yet.
export default function LiveMarkdown({ value, onChange, placeholder, onInsertRef }) {
  const [editIdx, setEditIdx] = useState(null);
  const [draft, setDraft] = useState('');
  const ta = useRef(null);
  const caret = useRef(null);     // 'start' | 'end' | number
  const idxRef = useRef(null);
  const draftRef = useRef('');
  idxRef.current = editIdx;
  draftRef.current = draft;

  const blocks = splitBlocks(value);

  function openBlock(i, where = 'end') {
    const text = blocks[i]?.text ?? '';
    if (editIdx === i) return;
    commit();
    caret.current = where;
    setDraft(text);
    setEditIdx(i);
  }

  // Write the draft back into the document. Returns the resulting markdown.
  function commit(nextDraft, nextIdx = null) {
    const i = idxRef.current;
    if (i == null) return value;
    const text = nextDraft ?? draftRef.current;
    const texts = splitBlocks(value).map(b => b.text);
    if (i >= texts.length) { if (text.trim()) texts.push(text); }
    else texts[i] = text;
    const out = joinBlocks(texts);
    if (out !== value) onChange(out);
    setEditIdx(nextIdx);
    return out;
  }

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (caret.current != null) {
      el.focus({ preventScroll: true });
      const pos = caret.current === 'start' ? 0 : caret.current === 'end' ? el.value.length : caret.current;
      el.setSelectionRange(pos, pos);
      caret.current = null;
    }
  }, [draft, editIdx]);

  // Parent inserts text (quotes from the reader)
  useEffect(() => {
    if (!onInsertRef) return;
    onInsertRef.current = text => {
      if (idxRef.current != null && ta.current) {
        const el = ta.current;
        const p = el.selectionEnd;
        const nd = draftRef.current.slice(0, p) + text + draftRef.current.slice(p);
        caret.current = p + text.length;
        setDraft(nd);
      } else {
        onChange(joinBlocks([...splitBlocks(value).map(b => b.text), text]));
      }
    };
  });

  function onKeyDown(e) {
    const el = e.target;
    if (e.key === 'Escape') { e.preventDefault(); commit(); return; }
    // Blank line at the end → start a new block below (Obsidian-style paragraph break)
    if (e.key === 'Enter' && !e.shiftKey && el.selectionStart === el.value.length && el.value.endsWith('\n')) {
      e.preventDefault();
      const i = idxRef.current;
      const texts = splitBlocks(value).map(b => b.text);
      const body = draft.replace(/\n+$/, '');
      if (i >= texts.length) { if (body.trim()) texts.push(body); }
      else texts[i] = body;
      const out = joinBlocks(texts);
      if (out !== value) onChange(out);
      caret.current = 'end';
      setDraft('');
      setEditIdx(splitBlocks(out).length);   // trailing, not-yet-stored block
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = el.selectionStart;
      caret.current = s + 2;
      setDraft(draft.slice(0, s) + '  ' + draft.slice(el.selectionEnd));
      return;
    }
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && editIdx > 0) { e.preventDefault(); openBlock(editIdx - 1, 'end'); }
    else if (e.key === 'ArrowDown' && el.selectionEnd === el.value.length && editIdx < blocks.length - 1) { e.preventDefault(); openBlock(editIdx + 1, 'start'); }
    else if (e.key === 'Backspace' && el.value === '') {
      e.preventDefault();
      const texts = splitBlocks(value).map(b => b.text);
      const i = idxRef.current;
      if (i < texts.length) texts.splice(i, 1);
      const out = joinBlocks(texts);
      if (out !== value) onChange(out);
      const prev = Math.max(0, Math.min(i, splitBlocks(out).length) - 1);
      caret.current = 'end';
      setDraft(splitBlocks(out)[prev]?.text ?? '');
      setEditIdx(splitBlocks(out).length ? prev : 0);
    }
  }

  const input = (
    <textarea key="input" ref={ta} className="live-input" value={draft} spellCheck={false}
      onChange={e => setDraft(e.target.value)} onBlur={() => commit()} onKeyDown={onKeyDown} />
  );
  const isEmpty = !value?.trim();

  return (
    <div className="live-md">
      {isEmpty && editIdx == null ? (
        <div className="live-placeholder muted" onClick={() => { caret.current = 'end'; setDraft(''); setEditIdx(0); }}>{placeholder}</div>
      ) : blocks.map((b, i) => i === editIdx ? input : (
        <div key={i} className="live-block" onClick={e => {
          if (e.target.closest('a, input[type=checkbox]')) return;
          openBlock(i, caretFromClick(e, b.text));
        }}>
          <Markdown text={b.text || ' '} />
        </div>
      ))}
      {editIdx != null && editIdx >= blocks.length && input}
      <div className="live-tail" onClick={() => {
        if (editIdx != null) return;
        caret.current = 'end'; setDraft(''); setEditIdx(blocks.length);
      }} />
    </div>
  );
}

// Approximate the raw-markdown caret from where the user clicked in the rendered block:
// count rendered characters before the click, then find that spot in the source.
function caretFromClick(e, src) {
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const node = pos?.offsetNode, off = pos?.offset;
  if (!node || node.nodeType !== 3 || !e.currentTarget.contains(node)) return 'end';
  // How many rendered characters precede the click
  let visible = 0;
  const w = document.createTreeWalker(e.currentTarget, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n === node) { visible += off; break; }
    visible += n.nodeValue.length;
  }
  // Project the source onto its rendered text, remembering where each visible char came from
  const map = [];
  const lines = src.split('\n');
  let at = 0;
  for (const line of lines) {
    let i = 0;
    const lead = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+))/);
    if (lead) i = lead[1].length;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') { i++; if (i < line.length) map.push(at + i); continue; }
      if (c === '*' || c === '_' || c === '`' || c === '$') continue;   // inline markers
      if (c === '[' || c === ']') continue;
      if (c === '(' && map.length && line[i - 1] === ']') {             // link target
        const close = line.indexOf(')', i);
        if (close > 0) { i = close; continue; }
      }
      map.push(at + i);
    }
    at += line.length + 1;
    map.push(at - 1);   // the newline itself is a visible break
  }
  if (!map.length) return 'end';
  const k = Math.min(visible, map.length - 1);
  return visible >= map.length ? 'end' : map[k];
}

// Split on blank lines, keeping fenced code blocks together
export function splitBlocks(src) {
  const lines = (src || '').split('\n');
  const out = [];
  let cur = [], fence = null;
  const push = () => { out.push({ text: cur.join('\n').replace(/\s+$/, '') }); cur = []; };
  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      cur.push(line);
      if (f && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (f) { fence = f[1]; cur.push(line); continue; }
    if (line.trim() === '') { if (cur.length) push(); continue; }
    cur.push(line);
  }
  if (cur.length) push();
  return out;
}
const joinBlocks = texts => texts.filter(t => t.trim() !== '').join('\n\n');
