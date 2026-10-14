import { useMemo } from 'react';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import DOMPurify from 'dompurify';

const md = new Marked({ gfm: true, breaks: true });
md.use(markedKatex({ throwOnError: false, nonStandard: true }));

// Links open in a new tab
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

export function renderMd(text) {
  return DOMPurify.sanitize(md.parse(text || ''), { ADD_TAGS: ['semantics', 'annotation', 'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mspace', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mstyle'], ADD_ATTR: ['encoding', 'aria-hidden'] });
}

export default function Markdown({ text, className = '' }) {
  const html = useMemo(() => renderMd(text), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
