import { scanTierA, resolveOverlaps } from './tierA/index.js';
import { judge } from './tierB/judge.js';
import * as cache from './tierB/cache.js';

/** Separator between segments; also what the caller uses to join them. */
export const SEP = '\n␞\n';

/**
 * The two-tier pipeline. Tier A always runs. Tier B runs only on text that is
 * both substantial enough to hide semantic leakage and not already judged -
 * which is the answer to "doesn't an LLM call on every prompt destroy your
 * latency?" on both axes: most prompts never reach it, and a conversation
 * never pays twice for the same message.
 *
 * @param {string[]} segments - the editable text pieces of the request
 * @returns findings with offsets in the joined coordinate space
 */
export async function detect(segments, { policy, watchlist, signal } = {}) {
  const list = Array.isArray(segments) ? segments : [String(segments ?? '')];
  const joined = list.join(SEP);

  const tierAStart = performance.now();
  const tierA = scanTierA(joined, { watchlist });
  const tierAMs = performance.now() - tierAStart;

  // Where each segment begins inside the joined text.
  const offsets = [];
  let at = 0;
  for (const s of list) {
    offsets.push(at);
    at += s.length + SEP.length;
  }

  // Split into what we already know and what still needs a model.
  const cached = [];
  const fresh = [];
  list.forEach((segment, i) => {
    if (!segment.trim()) return;
    const known = cache.get(segment);
    if (known) cached.push(...known.map((f) => shift(f, offsets[i])));
    else fresh.push({ index: i, text: segment });
  });

  const freshText = fresh.map((f) => f.text).join(SEP);
  const decision = shouldRunTierB(freshText, tierA, policy);

  if (!decision.run) {
    return {
      findings: resolveOverlaps([...tierA, ...cached]),
      tierAMs,
      tierBMs: null,
      tierBRan: false,
      tierBSkipReason: decision.reason,
      judgeDegraded: false,
      judgeError: null,
      cache: cache.stats(),
      reusedFindings: cached.length,
    };
  }

  const tierBStart = performance.now();
  const result = await judge(freshText, { signal });
  const tierBMs = performance.now() - tierBStart;

  const minConfidence = policy?.thresholds?.judge_min_confidence ?? 0.5;
  const kept = result.findings.filter((f) => f.confidence >= minConfidence);

  // Attribute each finding back to the segment it came from, cache it there,
  // then translate it into the joined coordinate space the caller expects.
  const perSegment = new Map(fresh.map((f) => [f.index, []]));
  const freshOffsets = [];
  let cursor = 0;
  for (const f of fresh) {
    freshOffsets.push({ index: f.index, start: cursor, end: cursor + f.text.length });
    cursor += f.text.length + SEP.length;
  }

  const tierB = [];
  for (const finding of kept) {
    const owner = freshOffsets.find((o) => finding.start >= o.start && finding.end <= o.end);
    if (!owner) continue; // spans a separator - not attributable to one message
    perSegment.get(owner.index).push(shift(finding, -owner.start));
    tierB.push(shift(finding, offsets[owner.index] - owner.start));
  }

  // Only cache a clean judgement; caching degraded output would make a
  // transient outage stick to a conversation for an hour.
  if (!result.degraded) {
    for (const [index, findings] of perSegment) cache.set(list[index], findings);
  }

  return {
    findings: resolveOverlaps([...tierA, ...cached, ...tierB]),
    tierAMs,
    tierBMs,
    tierBRan: true,
    tierBSkipReason: null,
    judgeDegraded: result.degraded,
    judgeError: result.error,
    judgeModel: result.model,
    cache: cache.stats(),
    reusedFindings: cached.length,
    judgedChars: freshText.length,
  };
}

const shift = (f, by) => ({ ...f, start: f.start + by, end: f.end + by });

/**
 * Tier B is worth its cost when there is new prose for it to read. Short,
 * structured, already-judged or already-conclusive text goes straight through.
 */
export function shouldRunTierB(text, tierAFindings, policy) {
  const cfg = policy?.tier_b ?? {};
  if (cfg.enabled === false) return { run: false, reason: 'tier_b disabled by policy' };

  if (!text.trim()) return { run: false, reason: 'no new text - every message was already judged' };
  if (cfg.always === true) return { run: true, reason: 'policy: always' };

  const minChars = cfg.min_chars ?? 80;
  const minWords = cfg.min_words ?? 12;
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  if (text.length < minChars && words < minWords) {
    return { run: false, reason: `below tier_b threshold (${text.length} new chars, ${words} words)` };
  }

  // A confirmed hard secret is already a block - no need to pay for a judge.
  const hardBlock = tierAFindings.some((f) => f.cls === 'secret' && f.confidence >= 0.95);
  if (hardBlock && cfg.skip_on_hard_block !== false) {
    return { run: false, reason: 'tier A found a conclusive secret' };
  }

  return { run: true, reason: 'new prose long enough to hide semantic leakage' };
}
