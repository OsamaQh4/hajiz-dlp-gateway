#!/usr/bin/env node
/**
 * What the gate threshold is actually worth, and how steady the judge is.
 *
 * `DLP_SENTENCE_HOT_ABOVE` has defaulted to 0.6 since the day it was written
 * and has never been measured, because the gate value it compares against was
 * computed inside the judge and thrown away. Now that every unit reports its
 * raw value, one pass over the corpus recovers the score at *every* candidate
 * threshold - no re-running per value, no extra spend.
 *
 * The same pass answers the other open question. Repeat it, and a unit whose
 * gate value moves between identical requests shows up as exactly that: a
 * number that moves. A sentence flagged in one run of three is either sitting
 * next to the threshold or the judge is unsteady, and these are different
 * problems with different fixes.
 *
 *   node tools/gate-sweep.mjs            # one pass
 *   node tools/gate-sweep.mjs --runs 5   # five, for variance
 *
 * Scoring mirrors bench/run.js: overlap-based, Tier B expectations only, since
 * the threshold cannot touch Tier A or the adjudication of its hits. Figures
 * here are comparable to that harness's "tier B (span level)" row and to
 * nothing else.
 */

import fs from 'node:fs';
import { scanTierA } from '../gateway/detect/tierA/index.js';
import { judgeWithJev } from '../gateway/detect/tierB/jev.js';
import { loadPolicy, getPolicy, watchlistFor } from '../gateway/policy/policy.js';
import { config } from '../gateway/config.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const RUNS = Math.max(1, Number(arg('--runs', 1)));

if (config.judge.provider !== 'jev') {
  console.error(`\n  This sweep measures the decision model's gate. DLP_JUDGE_PROVIDER is "${config.judge.provider}".`);
  console.error('  Set DLP_JUDGE_PROVIDER=jev and a DLP_JUDGE_API_KEY, then re-run.\n');
  process.exit(2);
}

loadPolicy();
const policy = getPolicy();
const corpus = JSON.parse(fs.readFileSync(new URL('../bench/corpus.json', import.meta.url), 'utf8'));
const samples = corpus.samples;

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const trim = (s, n = 52) => (s.length > n ? `${s.slice(0, n - 3).replace(/\s+/g, ' ')}...` : s.replace(/\s+/g, ' '));

/**
 * Where each expectation's text sits in the sample, so overlap can be judged.
 *
 * Two sets, and conflating them was worth 19 points of precision. Recall is
 * about the semantic expectations only, because the gate cannot reach Tier A.
 * False alarms must be judged against *every* expectation, exactly as
 * bench/run.js does: a sentence that happens to wrap a national ID is not the
 * judge inventing something, and scoring it as a false alarm reported 48%
 * precision where the bench measured 92% on the same corpus and the same model.
 */
const locate = (sample, tierBOnly) =>
  (sample.expect ?? [])
    .filter((e) => !tierBOnly || e.tier === 'B')
    .map((e) => {
      const start = sample.text.indexOf(e.text);
      return start === -1 ? null : { ...e, start, end: start + e.text.length };
    })
    .filter(Boolean);

const minConfidence = policy?.thresholds?.judge_min_confidence ?? 0.5;
const TAXONOMY_KEYS = new Set(Object.keys((await import('../gateway/detect/tierB/jev.js')).TAXONOMY));

console.log(`\n  gate sweep  —  ${config.jev.model}, ${samples.length} samples, ${RUNS} run(s)\n`);

// ---- collect raw answers --------------------------------------------------
const observations = []; // one per (run, sample): { runIdx, sample, expected, units }
let calls = 0;
let degraded = 0;

for (let run = 0; run < RUNS; run += 1) {
  if (RUNS > 1) process.stdout.write(`  run ${run + 1} of ${RUNS}...\r`);
  for (const sample of samples) {
    const tierA = scanTierA(sample.text, { watchlist: watchlistFor(null) });
    // Force every unit through: the sweep supplies the threshold afterwards.
    const r = await judgeWithJev(sample.text, tierA, {
      policy: { ...policy, thresholds: { ...policy.thresholds, sentence_hot_above: 0 } },
    });
    calls += 1;
    if (r.degraded) {
      degraded += 1;
      continue;
    }
    observations.push({
      run,
      sample,
      expected: locate(sample, true),
      allExpected: locate(sample, false),
      units: r.units ?? [],
    });
  }
}
if (RUNS > 1) process.stdout.write('                              \r\n');

if (degraded) {
  console.error(`  ${degraded} of ${calls} calls degraded - the judge did not answer. Figures below would be fiction.`);
  if (degraded === calls) process.exit(1);
}

// ---- score at every candidate threshold -----------------------------------
const wouldFire = (u, t) =>
  u.hot >= t && u.cls && u.cls !== 'none' && TAXONOMY_KEYS.has(u.cls) && u.confidence >= minConfidence;

const scoreAt = (t) => {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let benignFp = 0;
  for (const o of observations) {
    const fired = o.units.filter((u) => wouldFire(u, t));
    for (const exp of o.expected) {
      if (fired.some((f) => overlaps(f, exp))) tp += 1;
      else fn += 1;
    }
    for (const f of fired) {
      if (o.allExpected.some((e) => overlaps(f, e))) continue;
      fp += 1;
      if (o.sample.kind === 'benign') benignFp += 1;
    }
  }
  return {
    t,
    tp,
    fn,
    fp,
    benignFp,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
};

const current = Number(process.env.DLP_SENTENCE_HOT_ABOVE ?? policy?.thresholds?.sentence_hot_above ?? 0.6);
const grid = [];
for (let t = 0.05; t <= 0.96; t += 0.05) grid.push(Number(t.toFixed(2)));
if (!grid.includes(current)) grid.push(current);
grid.sort((a, b) => a - b);

const rows = grid.map(scoreAt);
const f1 = (r) => (r.precision && r.recall ? (2 * r.precision * r.recall) / (r.precision + r.recall) : 0);
const best = rows.reduce((a, b) => (f1(b) > f1(a) ? b : a));

console.log('  threshold   precision   recall      F1      false alarms  on benign');
console.log('  ---------------------------------------------------------------------');
for (const r of rows) {
  const mark = r.t === current ? ' <- current' : r === best ? ' <- best F1' : '';
  console.log(
    `  ${r.t.toFixed(2)}        ${(r.precision === null ? '  n/a' : pct(r.precision)).padStart(6)}      ` +
      `${(r.recall === null ? '  n/a' : pct(r.recall)).padStart(6)}   ${pct(f1(r)).padStart(6)}   ` +
      `${String(r.fp).padStart(8)}      ${String(r.benignFp).padStart(6)}${mark}`,
  );
}

// ---- stability, per unit ---------------------------------------------------
if (RUNS > 1) {
  const byUnit = new Map();
  for (const o of observations) {
    for (const u of o.units) {
      const key = `${o.sample.id}\u0000${u.start}\u0000${u.end}`;
      if (!byUnit.has(key)) {
        byUnit.set(key, { sample: o.sample, text: u.text, short: u.short, hots: [], classes: new Set(), runs: [] });
      }
      const e = byUnit.get(key);
      e.hots.push(u.hot);
      e.runs.push(u);
      if (u.cls) e.classes.add(u.cls);
    }
  }

  const moved = [...byUnit.values()]
    .filter((e) => e.hots.length > 1 && Math.max(...e.hots) !== Math.min(...e.hots))
    .map((e) => ({ ...e, lo: Math.min(...e.hots), hi: Math.max(...e.hots) }))
    .sort((a, b) => b.hi - b.lo - (a.hi - a.lo));

  /**
   * What actually matters is whether the unit becomes a finding, and the gate
   * value is only one of three things that decide it. Tracking the gate alone
   * reported "0 units crossed the threshold" in a run where bench/run.js had
   * just shown a false alarm appearing in 1 of 3 - because the unit's *class*
   * flipped between `none` and a real category while its gate value sat still.
   * So the instability is measured on the whole predicate, and the cause named.
   */
  const unstable = [...byUnit.values()]
    .map((e) => {
      const fires = e.runs.filter((r) => wouldFire(r, current)).length;
      return { ...e, fires, total: e.runs.length };
    })
    .filter((e) => e.fires > 0 && e.fires < e.total)
    .map((e) => {
      const gateCrossed = e.runs.some((r) => r.hot < current) && e.runs.some((r) => r.hot >= current);
      const classes = new Set(e.runs.map((r) => r.cls ?? 'none'));
      const confCrossed =
        e.runs.some((r) => r.confidence < minConfidence) && e.runs.some((r) => r.confidence >= minConfidence);
      const causes = [];
      if (gateCrossed) causes.push(`gate crossed ${current.toFixed(2)}`);
      if (classes.size > 1) causes.push(`class varied (${[...classes].join(' / ')})`);
      if (confCrossed) causes.push(`confidence crossed ${minConfidence}`);
      return { ...e, causes };
    })
    .sort((a, b) => a.fires / a.total - b.fires / b.total);

  console.log(`\n  Across ${RUNS} runs`);
  console.log('  ---------------------------------------------------------------------');
  console.log(`  units judged             ${byUnit.size}`);
  console.log(`  gate value moved at all  ${moved.length}`);
  console.log(`  findings that flipped    ${unstable.length}   <- fired in some runs, not others`);

  for (const e of unstable) {
    console.log(
      `\n    ${e.sample.id}${e.short ? ' (short line)' : ''}  —  fires in ${e.fires}/${e.total} runs\n` +
        `      "${trim(e.text)}"\n` +
        `      gate ${Math.min(...e.hots).toFixed(2)} – ${Math.max(...e.hots).toFixed(2)}` +
        `   cause: ${e.causes.join('; ') || 'unclear'}`,
    );
  }

  if (!unstable.length) {
    console.log(`\n  No finding changed between runs. ${moved.length} gate values moved without`);
    console.log('  crossing anything that matters, which is the useful shape: noisy');
    console.log('  underneath, steady at the decision. It is still only an observation');
    console.log(`  over ${RUNS} runs, not a guarantee.`);
  }
}

console.log(`\n  Current threshold ${current.toFixed(2)}: precision ${pct(scoreAt(current).precision ?? 0)}, recall ${pct(scoreAt(current).recall ?? 0)}`);
console.log(`  Best F1 at ${best.t.toFixed(2)}: precision ${pct(best.precision ?? 0)}, recall ${pct(best.recall ?? 0)}`);
console.log('\n  A threshold picked off 35 hand-built samples is a starting point, not a');
console.log('  setting. Sweep it again on your own traffic before trusting the shape.\n');
