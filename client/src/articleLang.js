// The app is lang="zh-CN", which makes macOS resolve the system font to PingFang for everything —
// English articles then get PingFang's Latin glyphs and full-width curly quotes. Tag the article
// with its own language so the font stack picks Latin or CJK faces correctly.
export function articleLang(text) {
  const sample = text.replace(/```[\s\S]*?```|`[^`]*`|\$\$[\s\S]*?\$\$|!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g, '').slice(0, 20000);
  const kana = (sample.match(/[぀-ヿ]/g) || []).length;
  const hangul = (sample.match(/[가-힯]/g) || []).length;
  const han = (sample.match(/[一-鿿]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]+/g) || []).length;   // words, roughly comparable to Han characters
  const cjk = han + kana + hangul;
  if (cjk < latin * 0.5) return 'en';
  if (kana > cjk * 0.1) return 'ja';
  if (hangul > cjk * 0.3) return 'ko';
  return 'zh-CN';
}
