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
    const rehashed = sha256(JSON.stringify(body));

    // Which of the two checks failed is the whole finding, not a detail.
    // A content mismatch means this record was edited in place after it was
    // written. A broken link means a record was removed or reordered. They are
    // different attacks and an auditor acts on them differently, so the
    // verification says which rather than only that something is wrong.
    if (rehashed !== hash || body.prev !== prev) {
      return {
        ok: false,
        records: n,
        brokenAt: n,
        reason: rehashed !== hash ? 'content' : 'link',
        detail: {
          seq: n,
          requestId: entry.requestId ?? null,
          ts: entry.ts ?? null,
          sealedHash: hash,
          rehashed,
          expectedPrev: prev,
          storedPrev: body.prev ?? null,
          contentMatches: rehashed === hash,
          linkMatches: body.prev === prev,
        },
      };
    }
    prev = hash;
  }
  return { ok: true, records: n, brokenAt: null, reason: null, head: prev === GENESIS ? null : prev };
}

/** Summary of one request, shaped for the log and for the dashboard. */
export function summarize({ requestId, sessionId, group, route, action, decision, timings, judge, via = 'baseurl' }) {
  const byClass = {};
  for (const f of decision.perFinding) {
    byClass[f.cls] = (byClass[f.cls] || 0) + 1;
  }
  return {
    requestId,
    sessionId,
    group: group || null,
    route,
    // How the request reached the appliance. The three deployment modes have
    // different blast radii, so "what would stop working" is a question about
    // the split rather than the total.
    via,
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

/**
 * Read records for the console, newest first.
 *
 * The log is append-only and can be large, so this streams rather than
 * loading the file: an auditor paging through six months of traffic must not
 * cost the gateway its memory while it is still inspecting prompts.
 *
 * Reading backwards from a forward-only stream means collecting the tail, so
 * `offset + limit` bounds how much is ever held at once.
 */
export async function readRecords({ limit = 50, offset = 0, filter = '', action = '' } = {}, file = config.auditPath) {
  if (!fs.existsSync(file)) return { records: [], total: 0, seqOf: {} };

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const keep = [];
  const want = offset + limit;
  const needle = filter.trim().toLowerCase();
  let seq = 0;
  let total = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    seq += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (action && entry.action !== action) continue;
    if (needle) {
      const hay = [
        entry.sessionId, entry.group, entry.action, entry.route,
        Object.keys(entry.byClass ?? {}).join(' '), (entry.detectors ?? []).join(' '),
      ].join(' ').toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    total += 1;
    keep.push({ ...entry, seq });
    // Keep only as much tail as the caller could possibly ask for.
    if (keep.length > want + 200) keep.splice(0, keep.length - (want + 200));
  }

  const newestFirst = keep.reverse();
  return { records: newestFirst.slice(offset, offset + limit), total };
}

/**
 * An evidence bundle: the records, the verification that was true when it was
 * taken, and the chain head. Produced as one object so that what an auditor
 * carries away cannot be a set of rows whose provenance has been separated
 * from the proof that they are intact.
 */
export async function evidenceBundle({ filter = '', action = '' } = {}, file = config.auditPath) {
  const verification = await verifyChain(file);
  const { records, total } = await readRecords({ limit: 100000, offset: 0, filter, action }, file);
  return {
    takenAt: new Date().toISOString(),
    source: file,
    verification,
    head: records[0]?.hash ?? null,
    filter: { text: filter || null, action: action || null },
    count: records.length,
    total,
    records,
  };
}
