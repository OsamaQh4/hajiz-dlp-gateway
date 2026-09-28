import { detectors, watchlistDetector } from './patterns.js';

/**
 * Run every deterministic detector over `text` and return non-overlapping
 * findings, highest-priority span wins.
 *
 * @returns {Array<{start:number,end:number,text:string,cls:string,detector:string,confidence:number,tier:'A'}>}
 */
export function scanTierA(text, { watchlist = [] } = {}) {
  if (!text) return [];
  const active = [...detectors];
  const wl = watchlistDetector(watchlist);
  if (wl) active.push(wl);

  const raw = [];
  for (const d of active) {
    // Each scan gets its own regex instance so lastIndex is never shared.
    const re = new RegExp(d.regex.source, d.regex.flags.includes('g') ? d.regex.flags : `${d.regex.flags}g`);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') {
        re.lastIndex += 1;
        continue;
      }
      const useGroup = d.group != null && m[d.group] != null;
      const value = useGroup ? m[d.group] : m[0];
      const start = useGroup ? m.index + m[0].indexOf(m[d.group]) : m.index;
      if (d.validate && !d.validate(value)) continue;
      raw.push({
        start,
        end: start + value.length,
        text: value,
        cls: d.cls,
        detector: d.id,
        confidence: d.confidence,
        priority: d.priority,
        tier: 'A',
      });
    }
  }
  return resolveOverlaps(raw);
}

/**
 * Two detectors often claim the same characters (an IBAN also looks like a
 * high-entropy string). Keep the higher-priority one, then the longer one.
 */
export function resolveOverlaps(findings) {
  const sorted = [...findings].sort(
    (a, b) =>
      a.start - b.start ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      b.end - b.start - (a.end - a.start),
  );
  const kept = [];
  for (const f of sorted) {
    const clash = kept.find((k) => f.start < k.end && k.start < f.end);
    if (!clash) {
      kept.push(f);
      continue;
    }
    const better =
      (f.priority ?? 0) > (clash.priority ?? 0) ||
      ((f.priority ?? 0) === (clash.priority ?? 0) && f.end - f.start > clash.end - clash.start);
    if (better) kept.splice(kept.indexOf(clash), 1, f);
  }
  return kept.sort((a, b) => a.start - b.start);
}
