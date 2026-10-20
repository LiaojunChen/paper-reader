// Text fixes shared by the server (on import) and the client (on render).
// Kept dependency-free so Vite can bundle it and Node can test it without pulling in Readability.

// Pages that leave raw TeX in the text for MathJax ($a_t$, \(x^2\), $$…$$) come out of Turndown
// with Markdown escapes inside the formula ($a\_t$, \\(x^2\\)). Undo the escapes in math spans only.
// Idempotent: running it again on already-clean Markdown changes nothing.
const MD_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~<>])/g;
export function unescapeMath(md = '') {
  const fix = s => s.replace(MD_ESCAPE, '$1');
  return md
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `$$${fix(tex)}$$`)
    .replace(/\\\\\[([\s\S]+?)\\\\\]/g, (_m, tex) => `$$${fix(tex)}$$`)
    .replace(/\\\\\(([\s\S]+?)\\\\\)/g, (_m, tex) => `$${fix(tex)}$`)
    // Inline $…$: no space just inside the dollars and no digit right after the closing one, so "$5 and $10" is left alone
    .replace(/(^|[^\\$])\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g, (_m, pre, tex) => `${pre}$${fix(tex)}$`);
}
