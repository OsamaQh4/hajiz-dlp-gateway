import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * What happens when an escalated prompt gets no human answer.
 *
 * The rule being tested: the decision model may take the call, but trust
 * ratchets. Consecutive decisions made without a human are counted, and past
 * the administrator's limit every later timeout blocks regardless of what the
 * model says. One human answer resets the run. An unattended queue can only
 * get stricter.
 */

const port = 9700 + (process.pid % 200);
process.env.DLP_JUDGE_PROVIDER = 'jev';
process.env.DLP_JEV_ENDPOINT = `http://127.0.0.1:${port}/decisions`;
process.env.DLP_JEV_MODEL = 'fake-jev';
process.env.DLP_JUDGE_API_KEY = 'test-key';

let server;
let verdict = { choice: 'forward', confidence: 0.95 };
let status = 200;
let calls = 0;

before(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls += 1;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ answers: { verdict } }) : '{"error":"down"}');
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => server?.close());

const { adjudicateUnreviewed, recordHumanDecision, consecutiveAutoDecisions, resetAll } = await import(
  '../gateway/detect/tierB/adjudicate.js'
);

const POLICY = {
  escalation: { on_timeout: 'judge', min_confidence: 0.75, auto_decisions_before_block: 3, counter_scope: 'session' },
};
const DECISION = { perFinding: [{ cls: 'strategic', action: 'escalate' }] };
const call = (sessionId = 's1', policy = POLICY) =>
  adjudicateUnreviewed({ sanitized: 'Draft a note about ORG_1 and the plan.', decision: DECISION, sessionId, policy });

beforeEach(() => {
  resetAll();
  verdict = { choice: 'forward', confidence: 0.95 };
  status = 200;
  calls = 0;
});

test('a confident forward verdict releases the request', async () => {
  const r = await call();
  assert.equal(r.approved, true);
  assert.equal(r.by, 'judge');
  assert.equal(r.consecutive, 1);
});

test('a hold verdict blocks it', async () => {
  verdict = { choice: 'hold', confidence: 0.9 };
  const r = await call();
  assert.equal(r.approved, false);
  assert.match(r.reason, /insufficient/);
});

test('an unconfident approval is not accepted', async () => {
  verdict = { choice: 'forward', confidence: 0.5 };
  const r = await call();
  assert.equal(r.approved, false, '0.5 is under the 0.75 bar');
  assert.match(r.reason, /under the 75% bar/);
});

test('trust ratchets: past the limit, approval stops being possible', async () => {
  // Three unattended decisions are allowed; the fourth is blocked whatever the
  // model says, because nobody has been watching.
  for (let i = 1; i <= 3; i += 1) {
    const r = await call();
    assert.equal(r.approved, true, `decision ${i} should still be allowed`);
    assert.equal(r.consecutive, i);
  }

  const callsBefore = calls;
  const fourth = await call();
  assert.equal(fourth.approved, false);
  assert.equal(fourth.by, 'ratchet');
  assert.match(fourth.reason, /3 consecutive decisions/);
  assert.equal(calls, callsBefore, 'past the limit it does not even ask');
});

test('a human answer resets the run', async () => {
  await call();
  await call();
  assert.equal(consecutiveAutoDecisions({ sessionId: 's1', policy: POLICY }), 2);

  recordHumanDecision({ sessionId: 's1', policy: POLICY });
  assert.equal(consecutiveAutoDecisions({ sessionId: 's1', policy: POLICY }), 0);

  const r = await call();
  assert.equal(r.approved, true);
  assert.equal(r.consecutive, 1, 'the count starts again');
});

test('the limit is the administrator’s to set', async () => {
  const strict = { escalation: { ...POLICY.escalation, auto_decisions_before_block: 1 } };
  const first = await call('s2', strict);
  assert.equal(first.approved, true);
  const second = await call('s2', strict);
  assert.equal(second.approved, false);
  assert.equal(second.by, 'ratchet');
});

test('runs are counted per session, so one unattended queue cannot block everyone', async () => {
  for (let i = 0; i < 3; i += 1) await call('busy');
  const other = await call('quiet');
  assert.equal(other.approved, true, 'a different session starts clean');
});

test('an unreachable adjudicator fails closed', async () => {
  status = 500;
  const r = await call();
  assert.equal(r.approved, false);
  assert.equal(r.by, 'fail-closed');
  assert.equal(r.degraded, true);
});

test('a failed adjudication still counts toward the ratchet', async () => {
  // Otherwise a broken adjudicator would reset the safety net every time.
  status = 500;
  await call();
  assert.equal(consecutiveAutoDecisions({ sessionId: 's1', policy: POLICY }), 1);
});

test('the model is asked whether forwarding is acceptable, not what the span is', async () => {
  // Re-asking the question that caused the escalation would just be the same
  // model confirming itself.
  let body = null;
  const probe = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      body = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { verdict: { choice: 'hold', confidence: 0.9 } } }));
    });
  });
  await new Promise((r) => probe.listen(port + 1, '127.0.0.1', r));
  process.env.DLP_JEV_ENDPOINT = `http://127.0.0.1:${port + 1}/decisions`;
  const { config } = await import('../gateway/config.js');
  config.jev.endpoint = `http://127.0.0.1:${port + 1}/decisions`;

  await call('s9');
  assert.match(body.questions.verdict.instructions, /acceptable to send/i);
  assert.deepEqual(Object.keys(body.questions.verdict.criteria).sort(), ['forward', 'hold']);
  assert.deepEqual(body.state.flagged_categories, ['strategic']);
  probe.close();
});
