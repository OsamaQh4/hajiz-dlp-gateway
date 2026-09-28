/**
 * Detection benchmark.
 *
 * Judges ask two questions about any DLP claim: how much does it miss, and how
 * often does it cry wolf. This prints both, plus the latency distribution.
 *
 *   node bench/run.js                      # Tier A only - deterministic, no API key
 *   node bench/run.js --judge              # Tier A + the semantic judge (costs money)
 *   node bench/run.js --judge --runs 3     # repeat, and report the spread
 *
 * Options: --limit N (subset), --delay MS (pace a throttling endpoint),
 *          --runs N (repeat; an LLM judge is not deterministic), --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTierA } from '../gateway/detect/tierA/index.js';
import { judge } from '../gateway/detect/tierB/judge.js';
import { getPolicy } from '../gateway/policy/policy.js';
import { percentiles } from '../gateway/lib/events.js';
import { config, judgeResidency } from '../gateway/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8'));
const withJudge = process.argv.includes('--judge');
const verbose = process.argv.includes('--verbose');
const argValue = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
// A slow judge makes the full corpus a four-minute wait, so allow a subset run
// while tuning, and pacing for endpoints that throttle.
const limit = argValue('limit', Infinity);
const delayMs = argValue('delay', 0);
// An LLM judge is not deterministic, so a single run is a single sample. Repeat
// the whole corpus and report the spread - one figure from one run is not a
// result you can quote.
const runs = Math.max(1, argValue('runs', 1));
const tiers = withJudge ? ['A', 'B'] : ['A'];
const watchlist = getPolicy().watchlist || [];

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

async function score() {
  const scoreStarted = performance.now();
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let benignFp = 0;
  // Tier A's perfect score otherwise masks how the judge is doing. Scored
  // separately, because they are separate claims.
  // tp/fn are strict (the class must match too). ltp/lfn are span-level: was the
  // sensitive text found at all, by any class. Span-level is what decides
  // whether data leaks; the class only decides which action policy takes.
  const tier = () => ({ tp: 0, fp: 0, fn: 0, ltp: 0, lfn: 0 });
  const byTier = { A: tier(), B: tier(), H: tier() };
  let notMeasured = 0;
  // Aggregate rates can match while the underlying findings differ, so track
  // identity, not just counts.
  const caught = new Set();
  const alarms = new Set();
  const expectedKeys = new Set();
  const latencies = [];
  const judgeLatencies = [];
  const misses = [];
  const falseAlarms = [];
  // A judge that quietly falls back to keyword cues would otherwise be scored
  // as if the semantic layer worked. Track it and refuse to report it as "B".
  let judgeCalls = 0;
  let judgeDegraded = 0;
  let judgeSpans = 0;
  const judgeErrors = new Set();

  if (withJudge) {
    const jr = judgeResidency();
    console.log(`\n  judge: ${config.judge.provider}:${config.judge.model} — ${jr.residency} (${jr.host})`);
  }

  // When sampling a subset, keep leak and benign prompts in balance so the
  // false-positive number stays meaningful - and when the judge is in play,
  // prefer leaks that actually have Tier B expectations. Otherwise a subset of
  // key-and-ID samples scores Tier A and tells you nothing about the judge.
  const hasTierB = (s) => s.expect.some((e) => e.tier === 'B');
  const leaks = corpus.samples.filter((s) => s.kind === 'leak');
  const orderedLeaks = withJudge ? [...leaks].sort((a, b) => Number(hasTierB(b)) - Number(hasTierB(a))) : leaks;

  const samples = Number.isFinite(limit)
    ? [
        ...orderedLeaks.slice(0, Math.ceil(limit / 2)),
        ...corpus.samples.filter((s) => s.kind === 'benign').slice(0, Math.floor(limit / 2)),
      ]
    : corpus.samples;

  if (Number.isFinite(limit)) {
    console.log(`  running a subset: ${samples.length} of ${corpus.samples.length} samples`);
  }

  for (const sample of samples) {
    if (delayMs && withJudge) await new Promise((r) => setTimeout(r, delayMs));
    const expected = sample.expect
      .filter((e) => tiers.includes(e.tier))
      .map((e) => {
        const start = sample.text.indexOf(e.text);
        if (start === -1) throw new Error(`corpus error in ${sample.id}: expected span not present verbatim`);
        return { ...e, start, end: start + e.text.length };
      });

    const t0 = performance.now();
    let found = scanTierA(sample.text, { watchlist });
    const tierAMs = performance.now() - t0;
    latencies.push(tierAMs);

    let sampleDegraded = false;
    if (withJudge) {
      const t1 = performance.now();
      const res = await judge(sample.text);
      judgeLatencies.push(performance.now() - t1);
      judgeCalls += 1;
      if (res.degraded) {
        judgeDegraded += 1;
        sampleDegraded = true;
        if (res.error) judgeErrors.add(res.error);
      } else {
        judgeSpans += res.findings.length;
      }
      found = [...found, ...res.findings.filter((f) => f.confidence >= 0.5)];
    }

    // When the judge falls back, the spans come from keyword cues. Scoring
    // those as Tier B would credit the model for work it did not do, so the
    // per-tier view excludes them and says how many it skipped.
    const measuresJudge = (tier) => tier !== 'B' || !sampleDegraded;
    const bucketFor = (f) => (f.detector === 'heuristic' ? 'H' : (f.tier ?? 'A'));

    const matchedFound = new Set();
    for (const exp of expected) {
      const key = `${sample.id} · ${exp.text}`;
      expectedKeys.add(key);
      if (measuresJudge(exp.tier)) {
        if (found.some((f) => overlaps(f, exp))) byTier[exp.tier].ltp += 1;
        else byTier[exp.tier].lfn += 1;

        // Stability is about the judge, so a Tier A span that happens to
        // overlap a semantic expectation must not mask an unstable judge.
        const credit =
          exp.tier === 'B'
            ? (f) => overlaps(f, exp) && f.tier === 'B' && f.detector !== 'heuristic'
            : (f) => overlaps(f, exp);
        if (found.some(credit)) caught.add(key);
      }
      const hit = found.find((f, i) => !matchedFound.has(i) && overlaps(f, exp) && f.cls === exp.cls);
      if (hit) {
        matchedFound.add(found.indexOf(hit));
        tp += 1;
        if (measuresJudge(exp.tier)) byTier[exp.tier].tp += 1;
        else notMeasured += 1;
      } else {
        // A span found with the wrong class still redacts the data, so it is
        // not a miss in the sense that matters - but we count it separately.
        const looseHit = found.find((f) => overlaps(f, exp));
        fn += 1;
        if (measuresJudge(exp.tier)) byTier[exp.tier].fn += 1;
        else notMeasured += 1;
        misses.push({ id: sample.id, cls: exp.cls, text: exp.text, caughtAsOtherClass: looseHit?.cls ?? null });
      }
    }

    for (const f of found) {
      if (expected.some((e) => overlaps(f, e))) continue;
      fp += 1;
      byTier[bucketFor(f)].fp += 1;
      if (sample.kind === 'benign') benignFp += 1;
      alarms.add(`${sample.id} · ${f.text}`);
      falseAlarms.push({ id: sample.id, kind: sample.kind, cls: f.cls, detector: f.detector, text: f.text });
    }
  }

  return {
    tp, fp, fn, benignFp, byTier, notMeasured, latencies, judgeLatencies,
    misses, falseAlarms, judgeCalls, judgeDegraded, judgeSpans, judgeErrors, samples,
    caught, alarms, expectedKeys,
    elapsedMs: performance.now() - scoreStarted,
  };
}

async function main() {
  const results = [];
  for (let i = 1; i <= runs; i += 1) {
    if (runs > 1) console.log(`  run ${i} of ${runs}...`);
    results.push(await score());
  }
  const {
    tp, fp, fn, benignFp, byTier, notMeasured, latencies, judgeLatencies,
    misses, falseAlarms, judgeCalls, judgeDegraded, judgeSpans, judgeErrors, samples,
  } = results[results.length - 1];
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const benign = samples.filter((s) => s.kind === 'benign').length;
  const lat = percentiles(latencies);

  const judgeWorked = withJudge && judgeDegraded < judgeCalls;
  const label = !withJudge
    ? 'A'
    : judgeDegraded === judgeCalls
      ? 'A + DEGRADED CUES (the judge never answered)'
      : judgeDegraded
        ? `A + B (partially degraded: ${judgeDegraded}/${judgeCalls} calls fell back)`
        : 'A + B';

  console.log(`\n  Detection benchmark  —  tiers: ${label}`);
  console.log('  ' + '-'.repeat(56));
  console.log(`  samples            ${samples.length} (${benign} benign)`);
  console.log(`  true positives     ${tp}`);
  console.log(`  false positives    ${fp}  (${benignFp} on benign prompts)`);
  console.log(`  false negatives    ${fn}`);
  console.log(`  precision          ${pct(precision)}`);
  console.log(`  recall             ${pct(recall)}`);
  console.log(`  F1                 ${pct(f1)}`);
  console.log(`  clean-prompt FP    ${pct(benignFp / Math.max(1, benign))} of benign prompts raised something`);
  console.log(`  tier A latency     p50 ${lat.p50} ms · p95 ${lat.p95} ms · max ${lat.max} ms`);
  if (withJudge) {
    const line = (name, t, loose = false) => {
      const [tp, fn] = loose ? [t.ltp, t.lfn] : [t.tp, t.fn];
      const p = tp + t.fp ? tp / (tp + t.fp) : null;
      const r = tp + fn ? tp / (tp + fn) : null;
      const scored = tp + fn;
      return (
        `  ${name.padEnd(22)} precision ${p == null ? '  n/a' : pct(p).padStart(6)}` +
        ` · recall ${r == null ? '  n/a' : pct(r).padStart(6)}` +
        ` · ${scored} expectation${scored === 1 ? '' : 's'} scored, ${t.fp} false alarm${t.fp === 1 ? '' : 's'}`
      );
    };
    console.log('');
    console.log(line('tier A (strict class)', byTier.A));
    console.log(line('tier B (strict class)', byTier.B));
    console.log(line('tier B (span level)', byTier.B, true));
    if (byTier.H.fp) console.log(line('degraded fallback', byTier.H));
    if (notMeasured) {
      console.log(
        `  ... ${notMeasured} semantic expectation(s) excluded from the Tier B score — the judge` +
          ' fell back on those samples, so they measure keyword cues, not the model',
      );
    }
    if (byTier.B.tp + byTier.B.fn < 5) {
      console.log(
        `  ${'·'.repeat(3)} only ${byTier.B.tp + byTier.B.fn} semantic expectation(s) in this run — far too few to` +
          ' conclude anything about the judge. Run the full corpus.',
      );
    }
  }
  if (withJudge) {
    const jl = percentiles(judgeLatencies);
    console.log(`  tier B latency     p50 ${jl.p50} ms · p95 ${jl.p95} ms · max ${jl.max} ms`);
    console.log(`  judge calls        ${judgeCalls} (${judgeDegraded} degraded, ${judgeSpans} spans returned)`);
    const perRun = results.map((r) => r.elapsedMs);
    const avg = perRun.reduce((a, b) => a + b, 0) / perRun.length / 1000;
    console.log(
      `  wall clock         ${avg.toFixed(0)} s per run` +
        (runs > 1 ? ` · ${(avg * runs).toFixed(0)} s total` : ` · ${(avg * 3).toFixed(0)} s for --runs 3`),
    );
  }
  console.log('');

  if (withJudge && judgeDegraded) {
    console.log(`  ${'!'.repeat(56)}`);
    console.log(
      judgeDegraded === judgeCalls
        ? '  THE SEMANTIC JUDGE NEVER RAN. Every Tier B number above came from\n' +
            '  the degraded keyword fallback, not from a model. Do not quote these\n' +
            '  figures as evidence that the semantic layer works.'
        : `  ${judgeDegraded} of ${judgeCalls} judge calls fell back to keyword cues.\n` +
            '  The Tier B numbers above are a blend of model and fallback output.',
    );
    for (const err of judgeErrors) console.log(`    cause: ${err}`);
    console.log('  Check DLP_JUDGE_PROVIDER / DLP_JUDGE_BASE_URL / DLP_JUDGE_API_KEY');
    console.log(`  ${'!'.repeat(56)}\n`);
  }

  if (misses.length) {
    console.log('  Missed:');
    for (const m of misses) {
      const note = m.caughtAsOtherClass ? ` (caught, but classed as ${m.caughtAsOtherClass})` : '';
      console.log(`    ${m.id.padEnd(26)} ${m.cls.padEnd(14)} ${trim(m.text)}${note}`);
    }
    console.log('');
  }
  if (falseAlarms.length && (verbose || falseAlarms.length <= 12)) {
    console.log('  False alarms:');
    for (const f of falseAlarms) {
      console.log(`    ${f.id.padEnd(26)} ${f.detector.padEnd(20)} ${trim(f.text)}`);
    }
    console.log('');
  }

  if (runs > 1) {
    console.log(`  Across ${runs} runs\n  ` + '-'.repeat(56));
    const spread = (name, pick) => {
      const values = results.map(pick).filter((v) => v != null);
      if (!values.length) return;
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const same = Math.abs(hi - lo) < 1e-9;
      console.log(
        `  ${name.padEnd(24)} ${same ? pct(mean) : `${pct(lo)} – ${pct(hi)}`}` +
          `${same ? '  (same rate every run)' : `   mean ${pct(mean)}`}`,
      );
    };
    const rate = (t, kind) => {
      const [num, den] =
        kind === 'precision' ? [t.tp, t.tp + t.fp] : [t.tp, t.tp + t.fn];
      return den ? num / den : null;
    };
    spread('tier A precision', (r) => rate(r.byTier.A, 'precision'));
    spread('tier A recall', (r) => rate(r.byTier.A, 'recall'));
    if (withJudge) {
      spread('tier B precision', (r) => rate(r.byTier.B, 'precision'));
      spread('tier B recall', (r) => rate(r.byTier.B, 'recall'));
      spread('clean-prompt FP rate', (r) => r.benignFp / Math.max(1, r.samples.filter((s) => s.kind === 'benign').length));
      const spans = results.map((r) => r.judgeSpans);
      console.log(`  spans returned           ${Math.min(...spans)} – ${Math.max(...spans)}`);

      // Identical rates can hide different findings, so report which spans
      // actually moved. For a compliance control, catching a different set of
      // things each run is a problem even when the rate is constant.
      const tally = (pick) => {
        const counts = new Map();
        for (const r of results) for (const k of pick(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts;
      };
      const caughtCounts = tally((r) => r.caught);
      const alarmCounts = tally((r) => r.alarms);
      const unstable = [...caughtCounts].filter(([, n]) => n < runs);
      const flakyAlarms = [...alarmCounts].filter(([, n]) => n < runs);

      console.log('');
      const total = results[0].expectedKeys.size;
      const everyRun = [...caughtCounts].filter(([, n]) => n === runs).length;
      console.log(`  stable detections        ${everyRun} of ${total} expectations found in every run`);
      if (total - everyRun - unstable.length > 0) {
        console.log(`  never found              ${total - everyRun - unstable.length}`);
      }
      for (const [key, n] of unstable) console.log(`    UNSTABLE (${n}/${runs})  ${trim(key)}`);
      if (flakyAlarms.length) {
        console.log(`  unstable false alarms    ${flakyAlarms.length} span(s) flagged in some runs but not others`);
        for (const [key, n] of flakyAlarms) console.log(`    (${n}/${runs})  ${trim(key)}`);
      }
      if (!unstable.length && !flakyAlarms.length) {
        console.log('  the judge returned the same findings every run');
      }
      const degraded = results.reduce((a, r) => a + r.judgeDegraded, 0);
      if (degraded) console.log(`  degraded calls           ${degraded} across all runs`);
    }
    console.log(
      '\n  Quote the range, not one run. Tier A is deterministic and will not move;\n' +
        '  anything that does move is the judge, and that is the honest number.\n',
    );
  }

  if (!withJudge) {
    console.log('  Tier B expectations were not scored. Re-run with --judge to include the semantic layer.');
  }
  if (withJudge && !judgeWorked) {
    // Exit non-zero so a degraded judge cannot pass silently in a script or CI.
    process.exitCode = 2;
  }
  console.log(
    '  Caveat: this corpus is small and hand-built. It is a regression harness,\n' +
      '  not evidence of production accuracy - quote it that way.\n',
  );
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const trim = (s) => (s.length > 46 ? `${s.slice(0, 43).replace(/\n/g, ' ')}...` : s.replace(/\n/g, ' '));

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
