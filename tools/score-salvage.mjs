#!/usr/bin/env node
/**
 * Scores, offline, what happens if a hot-but-unclassifiable unit is salvaged
 * instead of dropped.
 *
 * Today a unit the gate scored 0.82 is discarded outright when the twelve-way
 * class choice comes back uncertain or `none`. For a control that exists to
 * stop leaks, "definitely sensitive, not sure which kind" is the case a human
 * should see, not the case we throw away. But salvaging costs false alarms, and
 * how many is a measurement rather than an argument.
 *
 * Reads data/gate-sweep.json, so it spends nothing. Three policies:
 *
 *   drop      what ships today
 *   salvage   a real class was chosen but confidence fell short -> `other`
 *   force     as salvage, and also when the model answered `none` while the
 *             gate was hot, which is the two questions contradicting each other
 *
 * Scoring mirrors tools/gate-sweep.mjs, which mirrors bench/run.js.
 */

import fs from 'node:fs';
import { TAXONOMY } from '../gateway/detect/tierB/jev.js';

const file = process.argv[2] ?? 'data/gate-sweep.json';
if (!fs.existsSync(file)) {
  console.error(`\n  ${file} not found. Run: node tools/gate-sweep.mjs --runs 5\n`);
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const { minConfidence, currentThreshold } = data;
const KEYS = new Set(Object.keys(TAXONOMY));
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const pct = (n) => (n === null ? '   n/a' : `${(n * 100).toFixed(1)}%`);
const trim = (s, n = 54) => (s.length > n ? `${s.slice(0, n - 3).replace(/\s+/g, ' ')}...` : s.replace(/\s+/g, ' '));

/** What a unit becomes under a given policy, or null if it is dropped. */
const resolve = (u, t, policy) => {
  if (u.hot < t) return null;
  const usable = u.cls && u.cls !== 'none' && KEYS.has(u.cls);
  if (usable && u.confidence >= minConfidence) return { ...u, finalCls: u.cls, salvaged: false };
  if (policy === 'drop') return null;
  // The gate was hot. Keep it, as `other`, carrying the gate's own confidence -
  // policy escalates semantic findings, so this lands with a reviewer.
  if (usable) return { ...u, finalCls: 'other', confidence: u.hot, salvaged: true };
  if (policy === 'force' && (!u.cls || u.cls === 'none')) {
    return { ...u, finalCls: 'other', confidence: u.hot, salvaged: true };
  }
  return null;
};

const score = (t, policy) => {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let benignFp = 0;
  let salvagedTp = 0;
  let salvagedFp = 0;
  const salvagedSpans = [];

  for (const o of data.observations) {
    const fired = o.units.map((u) => resolve(u, t, policy)).filter(Boolean);
    for (const exp of o.expected) {
      if (fired.some((f) => overlaps(f, exp))) tp += 1;
      else fn += 1;
    }
    for (const f of fired) {
      const legit = o.allExpected.some((e) => overlaps(f, e));
      if (legit) {
        if (f.salvaged) salvagedTp += 1;
        continue;
      }
      fp += 1;
      if (f.salvaged) salvagedFp += 1;
      if (o.kind === 'benign') benignFp += 1;
      if (f.salvaged) salvagedSpans.push({ id: o.id, text: f.text, hot: f.hot, cls: f.cls });
    }
  }

  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  return {
    tp, fn, fp, benignFp, precision, recall,
    f1: precision && recall ? (2 * precision * recall) / (precision + recall) : 0,
    salvagedTp, salvagedFp, salvagedSpans,
  };
};

console.log(`\n  salvage scoring  —  ${data.model}, ${data.runs} runs, recorded ${data.recordedAt.slice(0, 16)}`);
console.log(`  no calls made; re-scored from ${file}\n`);

for (const t of [currentThreshold, 0.6, 0.8]) {
  console.log(`  gate ${t.toFixed(2)}`);
  console.log('    policy     precision   recall      F1    false alarms  on benign   salvaged good/bad');
  for (const policy of ['drop', 'salvage', 'force']) {
    const r = score(t, policy);
    console.log(
      `    ${policy.padEnd(9)}  ${pct(r.precision).padStart(7)}    ${pct(r.recall).padStart(7)}  ` +
        `${pct(r.f1).padStart(6)}  ${String(r.fp).padStart(8)}    ${String(r.benignFp).padStart(7)}   ` +
        `${String(r.salvagedTp).padStart(5)} / ${r.salvagedFp}`,
    );
  }
  console.log('');
}

// What exactly the salvage would hand a reviewer that it should not.
const at = score(currentThreshold, 'salvage');
if (at.salvagedSpans.length) {
  console.log(`  What salvage sends to a reviewer wrongly, at gate ${currentThreshold.toFixed(2)}:`);
  const seen = new Map();
  for (const s of at.salvagedSpans) {
    const k = `${s.id}\u0000${s.text}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    const [id, text] = k.split('\u0000');
    console.log(`    ${n}x  ${id}  "${trim(text)}"`);
  }
} else {
  console.log(`  At gate ${currentThreshold.toFixed(2)} the salvage produced no false alarms at all.`);
}

console.log('\n  A salvaged finding is classed `other` and semantic, so policy escalates it.');
console.log('  The cost of a false one is a reviewer\'s minute; the cost of the drop it');
console.log('  replaces is the leak this product exists to stop.\n');
