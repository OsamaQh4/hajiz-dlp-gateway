import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';

/**
 * Append-only, tamper-evident audit log.
 *
 * Every record carries the hash of the one before it, so removing or editing a
 * past entry breaks the chain and `verifyChain()` says exactly where. Compliance
 * teams ask "can someone delete the evidence?" - this is the answer.
 *
 * Note what is NOT written here: the sensitive values themselves. The log
 * records classes, detectors and decisions, never the data it protected.
 */

const GENESIS = '0'.repeat(64);
let lastHash = null;
let stream = null;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function openStream() {
  if (stream) return stream;
  fs.mkdirSync(path.dirname(config.auditPath), { recursive: true });
  stream = fs.createWriteStream(config.auditPath, { flags: 'a' });
  return stream;
}

async function tailHash() {
  if (lastHash) return lastHash;
  if (!fs.existsSync(config.auditPath)) {
    lastHash = GENESIS;
    return lastHash;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(config.auditPath), crlfDelay: Infinity });
  let last = GENESIS;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      last = JSON.parse(line).hash ?? last;
    } catch {
      /* a corrupt line is itself a finding; verifyChain() will report it */
    }
  }
  lastHash = last;
  return lastHash;
}

/**
 * @param {object} record - decision metadata. Must not contain plaintext values.
 */
export async function append(record) {
  const prev = await tailHash();
  const body = { ts: new Date().toISOString(), ...record, prev };
  const hash = sha256(JSON.stringify(body));
  const entry = { ...body, hash };
  lastHash = hash;
  openStream().write(`${JSON.stringify(entry)}\n`);
  return entry;
}

/** @returns {Promise<{ok:boolean, records:number, brokenAt:number|null}>} */
export async function verifyChain(file = config.auditPath) {
  if (!fs.existsSync(file)) return { ok: true, records: 0, brokenAt: null };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let prev = GENESIS;
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    n += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return { ok: false, records: n, brokenAt: n };
    }
    const { hash, ...body } = entry;
    if (body.prev !== prev || sha256(JSON.stringify(body)) !== hash) {
      return { ok: false, records: n, brokenAt: n };
    }
    prev = hash;
  }
  return { ok: true, records: n, brokenAt: null };
}

/** Summary of one request, shaped for the log and for the dashboard. */
export function summarize({ requestId, sessionId, group, route, action, decision, timings, judge }) {
  const byClass = {};
  for (const f of decision.perFinding) {
    byClass[f.cls] = (byClass[f.cls] || 0) + 1;
  }
  return {
    requestId,
    sessionId,
    group: group || null,
    route,
    action,
    findings: decision.perFinding.length,
    byClass,
    detectors: [...new Set(decision.perFinding.map((f) => f.detector))],
    reasons: decision.reasons,
    tierAMs: round(timings.tierAMs),
    tierBMs: timings.tierBMs == null ? null : round(timings.tierBMs),
    tierBRan: timings.tierBRan,
    judgeModel: judge?.model ?? null,
    judgeDegraded: judge?.degraded ?? false,
    // Why the judge failed, so a dead semantic layer is diagnosable from the
    // log and the dashboard rather than only from the console.
    judgeError: judge?.error ?? null,
  };
}

const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
