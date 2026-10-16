// A multi-value register per field/path. Vector clocks distinguish an offline
// edit from an old copy, without trusting the wall clocks of different devices.
import crypto from 'node:crypto';

export const FORMAT = 'paper-reader-sync-v1';
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a, b) => a.seq - b.seq || a.device.localeCompare(b.device, 'en');
export const winner = record => record?.versions?.reduce((a, b) => !a || compare(a, b) < 0 ? b : a, null);
export const valueOf = record => winner(record)?.value ?? null;
export const dominates = (a, b) => Object.entries(b).every(([d, n]) => (a[d] || 0) >= n);

export function mergeRecord(a, b) {
  const candidates = new Map();
  for (const v of [...(a?.versions || []), ...(b?.versions || [])]) candidates.set(`${v.device}:${v.seq}`, v);
  const all = [...candidates.values()];
  return { versions: all.filter(v => !all.some(other => other !== v && dominates(other.vector, v.vector))).sort(compare) };
}

export function mergeMaps(...maps) {
  const result = Object.create(null);
  for (const map of maps) for (const [key, record] of Object.entries(map)) result[key] = mergeRecord(result[key], record);
  return result;
}

export function contextOf(records) {
  const vector = Object.create(null);
  for (const r of Object.values(records)) for (const v of r.versions) {
    for (const [d, n] of Object.entries(v.vector)) vector[d] = Math.max(vector[d] || 0, n);
  }
  return vector;
}

export function edit(records, key, value, device, vector) {
  if (records[key] && equal(valueOf(records[key]), value)) return false;
  const seq = Math.max(0, ...Object.values(vector)) + 1;
  vector[device] = seq;
  records[key] = { versions: [{ value, device, seq, vector: { ...vector } }] };
  return true;
}

export function capture(records, baseline, current, device) {
  const vector = contextOf(records);
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[key] ?? null, after = current[key] ?? null;
    if (!equal(before, after)) edit(records, key, after, device, vector);
  }
}

// A deterministic extra path makes both versions available on every device.
// Keep the original dots: an explicitly deleted conflict copy stays deleted.
export function preserveFileConflicts(records) {
  let count = 0;
  for (const [key, r] of Object.entries(records)) {
    if (!key.startsWith('vault/') || key.endsWith('/.paper-reader.json') || r.versions.length < 2) continue;
    const chosen = winner(r);
    for (const v of r.versions) {
      if (v === chosen || !v.value || equal(v.value, chosen.value)) continue;
      const dot = key.lastIndexOf('.'), slash = key.lastIndexOf('/');
      const pos = dot > slash ? dot : key.length;
      const copy = `${key.slice(0, pos)} (冲突-${v.device.slice(0, 8)}-${v.seq})${key.slice(pos)}`;
      records[copy] = mergeRecord(records[copy], { versions: [v] });
      count++;
    }
  }
  return count;
}

export function materialize(records) {
  return Object.fromEntries(Object.entries(records).map(([key, r]) => [key, valueOf(r)]).filter(([, value]) => value !== null));
}

export function validateManifest(m) {
  if (m?.format !== FORMAT || !m.records || typeof m.records !== 'object' || Array.isArray(m.records)) throw new Error('云端同步数据格式不受支持，请更新 Paper Reader');
  if (Object.keys(m.records).length > 500000) throw new Error('云端同步记录过多');
  for (const [key, r] of Object.entries(m.records)) {
    if (!/^(item|ann|vault|dir|pdf|text)\//.test(key) || !Array.isArray(r?.versions) || !r.versions.length || r.versions.length > 100) throw new Error('云端同步记录损坏');
    const dots = new Set();
    for (const v of r.versions) {
      if (!/^[a-f0-9]{32}$/.test(v.device) || !Number.isSafeInteger(v.seq) || v.seq < 1 || !v.vector || Array.isArray(v.vector) || v.vector[v.device] !== v.seq) throw new Error('云端同步版本损坏');
      for (const [d, n] of Object.entries(v.vector)) if (!/^[a-f0-9]{32}$/.test(d) || !Number.isSafeInteger(n) || n < 1) throw new Error('云端同步版本损坏');
      const dot = `${v.device}:${v.seq}`;
      if (dots.has(dot)) throw new Error('云端同步版本重复');
      dots.add(dot);
    }
  }
  return m;
}
