import { scanTierA, resolveOverlaps } from './tierA/index.js';
import { judge } from './tierB/judge.js';

/**
 * The two-tier pipeline. Tier A always runs. Tier B runs only when the text is
 * substantial enough to hide semantic leakage that patterns cannot see - which
 * is the answer to "doesn't an LLM call on every prompt destroy your latency?"
 */
export async function detect(text, { policy, watchlist, signal } = {}) {
  const tierAStart = performance.now();
  const tierA = scanTierA(text, { watchlist });
  const tierAMs = performance.now() - tierAStart;

  const decision = shouldRunTierB(text, tierA, policy);
  if (!decision.run) {
    return {
      findings: tierA,
      tierAMs,
      tierBMs: null,
      tierBRan: false,
      tierBSkipReason: decision.reason,
      judgeDegraded: false,
      judgeError: null,
    };
  }

  const tierBStart = performance.now();
  const result = await judge(text, { signal });
  const tierBMs = performance.now() - tierBStart;

  const minConfidence = policy?.thresholds?.judge_min_confidence ?? 0.5;
  const tierB = result.findings.filter((f) => f.confidence >= minConfidence);

  return {
    findings: resolveOverlaps([...tierA, ...tierB]),
    tierAMs,
    tierBMs,
    tierBRan: true,
    tierBSkipReason: null,
    judgeDegraded: result.degraded,
    judgeError: result.error,
    judgeModel: result.model,
  };
}

/**
 * Tier B is worth its cost when there is prose for it to read. Short,
 * structured, or already-conclusive text goes straight through on Tier A.
 */
export function shouldRunTierB(text, tierAFindings, policy) {
  const cfg = policy?.tier_b ?? {};
  if (cfg.enabled === false) return { run: false, reason: 'tier_b disabled by policy' };
  if (cfg.always === true) return { run: true, reason: 'policy: always' };

  const minChars = cfg.min_chars ?? 80;
  const minWords = cfg.min_words ?? 12;
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  if (text.length < minChars && words < minWords) {
    return { run: false, reason: `below tier_b threshold (${text.length} chars, ${words} words)` };
  }

  // A confirmed hard secret is already a block - no need to pay for a judge.
  const hardBlock = tierAFindings.some((f) => f.cls === 'secret' && f.confidence >= 0.95);
  if (hardBlock && cfg.skip_on_hard_block !== false) {
    return { run: false, reason: 'tier A found a conclusive secret' };
  }

  return { run: true, reason: 'prose long enough to hide semantic leakage' };
}
