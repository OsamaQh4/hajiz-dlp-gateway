/*
 * Policy version history.
 *
 * Every accepted write keeps a copy of the file as it was *before* the change,
 * so there is always something to go back to. The point is not tidiness: policy
 * is the one control surface where a wrong edit has an immediate and invisible
 * effect - a class quietly downgraded from block to allow looks like nothing at
 * all on the monitor, because the prompts it should have stopped simply pass.
 *
 * Copies are the whole file, not a diff. A diff of YAML is a thing you have to
 * reason about under pressure; a file you can put back is not.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, config } from '../config.js';

const DIR = path.join(ROOT, 'data', 'policy-versions');
const INDEX = path.join(DIR, 'index.json');

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  fs.writeFileSync(INDEX, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * Record the file as it stands now, before it is overwritten.
 * @returns the index entry
 */
export function snapshot({ text, by = 'console', summary = '', accepted = true, problems = [] } = {}) {
  ensure();
  const entries = readIndex();
  const seq = (entries[0]?.seq ?? 0) + 1;
  const body = text ?? safeRead(config.policyPath);
  const file = `v${String(seq).padStart(4, '0')}.yaml`;

  fs.writeFileSync(path.join(DIR, file), body ?? '');

  const entry = {
    seq,
    file,
    at: new Date().toISOString(),
    by,
    summary,
    accepted,
    problems,
    sha256: crypto.createHash('sha256').update(body ?? '').digest('hex').slice(0, 16),
    bytes: Buffer.byteLength(body ?? ''),
  };

  entries.unshift(entry);
  writeIndex(entries.slice(0, 200));
  return entry;
}

/** Newest first. */
export function list(limit = 50) {
  return readIndex().slice(0, limit);
}

/** The stored text of one version, or null. */
export function read(seq) {
  const entry = readIndex().find((e) => e.seq === Number(seq));
  if (!entry) return null;
  try {
    return fs.readFileSync(path.join(DIR, entry.file), 'utf8');
  } catch {
    return null;
  }
}

const safeRead = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
