// pdf.js core must be evaluated (it sets globalThis.pdfjsLib) before the viewer module
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
globalThis.pdfjsLib = pdfjsLib;

export { pdfjsLib };
export const DOC_OPTS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
  isEvalSupported: false,
};

let viewerMod;
export async function loadViewer() {
  viewerMod ||= await import('pdfjs-dist/web/pdf_viewer.mjs');
  return viewerMod;
}

// Expand "29-32, 35" → [29,30,31,32,35]
export function expandCite(s) {
  const out = [];
  for (const part of s.split(/\s*[,;]\s*/)) {
    const m = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (m) { const a = +m[1], b = +m[2]; if (b >= a && b - a < 60) for (let k = a; k <= b; k++) out.push(k); }
    else if (/^\d+$/.test(part.trim())) out.push(+part.trim());
  }
  return out;
}
export const CITE_GROUP_RE = /\[(\s*\d+(?:\s*[-–—,;]\s*\d+)*\s*)\]/g;
