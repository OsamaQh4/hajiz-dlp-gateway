import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config reads the environment at import time, so point the log at a temp file
// before anything pulls it in.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajiz-audit-'));
const logFile = path.join(dir, 'audit.jsonl');
process.env.DLP_AUDIT_LOG = logFile;

const { append, verifyChain, summarize } = await import('../gateway/audit/audit.js');

test('the audit chain verifies while it is intact', async () => {
  await append({ requestId: 'a', action: 'pseudonymize' });
  await append({ requestId: 'b', action: 'block' });
  await new Promise((r) => setTimeout(r, 50)); // let the write stream flush

  const result = await verifyChain(logFile);
  assert.equal(result.ok, true);
  assert.equal(result.records, 2);
});

test('editing a past record breaks the chain and points at the record', async () => {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.action = 'allow'; // quietly downgrade a past decision
  lines[0] = JSON.stringify(tampered);

  const tamperedFile = path.join(dir, 'tampered.jsonl');
  fs.writeFileSync(tamperedFile, `${lines.join('\n')}\n`);

  const result = await verifyChain(tamperedFile);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
});

test('deleting a record breaks the chain', async () => {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  const truncated = path.join(dir, 'deleted.jsonl');
  fs.writeFileSync(truncated, `${lines[1]}\n`); // drop the first entry
  const result = await verifyChain(truncated);
  assert.equal(result.ok, false);
});

test('the log records classes and decisions, never the sensitive values', () => {
  const record = summarize({
    requestId: 'r1',
    sessionId: 's1',
    group: null,
    route: '/v1/messages',
    action: 'pseudonymize',
    decision: {
      perFinding: [
        { cls: 'national_id', detector: 'saudi_national_id', text: '1098765439', action: 'pseudonymize' },
        { cls: 'email', detector: 'email', text: 'ahmed@example.sa', action: 'pseudonymize' },
      ],
      reasons: [],
    },
    timings: { tierAMs: 0.3, tierBMs: null, tierBRan: false },
    judge: { model: null, degraded: false },
  });

  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('1098765439'));
  assert.ok(!serialized.includes('ahmed@example.sa'));
  assert.deepEqual(record.byClass, { national_id: 1, email: 1 });
});
