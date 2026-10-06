/*
 * Writing policy back to disk.
 *
 * The order here is the whole design. A policy file that is briefly invalid is
 * a policy file the hot-reload watcher may read at exactly the wrong moment, so
 * nothing is written until the result has been parsed and validated in memory,
 * and the write itself is atomic - a temporary file renamed over the original,
 * which the filesystem makes indivisible. A reader either sees the old file or
 * the new one, never half of either.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { config } from '../config.js';
import { applyEdits } from './edit.js';
import { validatePolicy, loadPolicy } from './policy.js';
import { snapshot } from './versions.js';

/**
 * @param {Array<{path:string[], value?:any, list?:any[]}>} edits
 * @returns {{ok:true, entry:object}|{ok:false, problems:string[]}}
 */
export function writePolicy(edits, { by = 'console', summary = '' } = {}) {
  const file = config.policyPath;

  let before;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, problems: [`cannot read ${file}: ${err.message}`] };
  }

  let next;
  try {
    next = applyEdits(before, edits);
  } catch (err) {
    // A path that does not exist, or a key that holds a block. Refused rather
    // than guessed at - the file keeps whatever it had.
    return { ok: false, problems: [err.message] };
  }

  let parsed;
  try {
    parsed = yaml.load(next);
  } catch (err) {
    return { ok: false, problems: [`the result is not valid YAML: ${err.message}`] };
  }

  const problems = validatePolicy(parsed);
  if (problems.length) {
    // Recorded as a rejected attempt. Someone reading the history later wants
    // to know an edit was tried and refused, not just that nothing happened.
    snapshot({ text: next, by, summary, accepted: false, problems });
    return { ok: false, problems };
  }

  // Keep the file as it was before overwriting it.
  snapshot({ text: before, by, summary: summary || describe(edits), accepted: true });

  const tmp = path.join(path.dirname(file), `.policy.${process.pid}.tmp`);
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);

  // The watcher polls at an interval, so reload now rather than leaving the
  // console to report the old policy back to whoever just changed it.
  loadPolicy();

  return { ok: true, entry: { summary: summary || describe(edits), edits: edits.length } };
}

/**
 * Put the file back to a stored version, through the same validation. A stored
 * version was valid when it was written, but the taxonomy it refers to may have
 * moved since, so it is checked again rather than trusted.
 */
export function rollbackPolicy(text, { by = 'console', seq } = {}) {
  const file = config.policyPath;

  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    return { ok: false, problems: [`stored version is not valid YAML: ${err.message}`] };
  }

  const problems = validatePolicy(parsed);
  if (problems.length) return { ok: false, problems };

  try {
    snapshot({ by, summary: `rolled back to v${seq}`, accepted: true });
    const tmp = path.join(path.dirname(file), `.policy.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    loadPolicy();
    return { ok: true, entry: { summary: `rolled back to v${seq}` } };
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
}

function describe(edits) {
  return edits
    .map((e) => (e.list ? `${e.path.join('.')} list of ${e.list.length}` : `${e.path.join('.')} → ${e.value}`))
    .join(', ');
}
