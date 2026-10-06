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
      const matched = useGroup ? m[d.group] : m[0];
      const start = useGroup ? m.index + m[0].indexOf(m[d.group]) : m.index;

      let value = matched;
      if (d.validate && !d.validate(value)) {
        // A greedy match that fails its checksum used to be thrown away whole,
        // and for a pattern allowing internal whitespace that is a leak rather
        // than a near miss: "SA03…7519 AND CONFIRM" overshoots into the words
        // after it, fails mod-97, and the real IBAN inside is never reported.
        // Retracting to the last whitespace boundary finds it.
        const shorter = d.retract ? retractToValid(value, d.validate) : null;
        if (!shorter) continue;
        value = shorter;
      }

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
 * Trim a match back to the last whitespace boundary, repeatedly, until the
 * validator accepts it. Only prefixes are tried: the detector matched from a
 * word boundary, so the start is trustworthy and it is the tail that overshot.
 */
function retractToValid(value, validate) {
  let v = value;
  for (;;) {
    const cut = v.search(/\s[^\s]*$/);
    if (cut <= 0) return null;
    v = v.slice(0, cut);
    if (!v) return null;
    if (validate(v)) return v;
  }
}

/** Does one span strictly contain the other? */
const contains = (a, b) => a.start <= b.start && a.end >= b.end && (a.end - a.start) > (b.end - b.start);

/**
 * Two detectors often claim the same characters (an IBAN also looks like a
 * high-entropy string). Keep the higher-priority one, then the longer one.
 *
 * Containment is the exception. A sentence-level semantic finding and the
 * identifier inside it are not rival claims about the same characters - they
 * are different granularities carrying different actions. Dropping the wider
 * one let "Saned" (project -> pseudonymize) silently displace "acquiring Saned
 * next quarter" (strategic -> escalate), so the gateway substituted the
 * counterparty and forwarded the deal. That is the residual leak we measured
 * at 96%, caused by our own overlap resolution.
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
    const clash = kept.find((k) => f.start < k.end && k.start < f.end && !contains(k, f) && !contains(f, k));
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
