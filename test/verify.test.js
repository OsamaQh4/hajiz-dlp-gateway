import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The post-sanitization verification pass, against a fake decisions server.
 *
 * This exists because substitution removes names but not facts: masking the
 * counterparty still forwards "we are acquiring ORG_1 next quarter and it is
 * not yet public". The pipeline had no way to notice, and this is the pass
 * that does.
 */

const port = 9500 + (process.pid % 300);
process.env.DLP_JUDGE_PROVIDER = 'jev';
process.env.DLP_JEV_ENDPOINT = `http://127.0.0.1:${port}/decisions`;
process.env.DLP_JEV_MODEL = 'fake-jev';
process.env.DLP_JUDGE_API_KEY = 'test-key';

let server;
let lastRequest = null;
let answers = {};
let status = 200;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = JSON.parse(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ answers }) : '{"error":"nope"}');
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => server?.close());
beforeEach(() => {
  lastRequest = null;
  answers = {};
  status = 200;
});

const { verifySanitized } = await import('../gateway/detect/tierB/verify.js');

const POLICY = { verification: { enabled: true, leak_above: 0.8, min_chars: 60 } };
const SANITIZED =
  'Customer PERSON_1 reported that PROJECT_1 fails on login. We are acquiring ORG_1 next quarter and it is not yet public.';
const CLEAN =
  'Please explain the difference between symmetric and asymmetric encryption, and when each is appropriate for data at rest.';

test('a fact surviving substitution is caught', async () => {
  answers = { leak: { noul: 0.96 }, what: { choice: 'strategic', confidence: 0.98 } };
  const r = await verifySanitized(SANITIZED, { policy: POLICY });

  assert.equal(r.checked, true);
  assert.equal(r.leaked, true);
  assert.equal(r.what, 'strategic');
  assert.equal(r.probability, 0.96);
});

test('it reads the sanitized text, placeholders and all', async () => {
  answers = { leak: { noul: 0.1 }, what: { choice: 'nothing', confidence: 0.9 } };
  await verifySanitized(SANITIZED, { policy: POLICY });

  assert.equal(lastRequest.state.sanitized, SANITIZED);
  assert.match(lastRequest.state.description, /placeholders/);
  assert.deepEqual(Object.keys(lastRequest.questions).sort(), ['leak', 'what']);
});

test('properly sanitized text passes', async () => {
  answers = { leak: { noul: 0.05 }, what: { choice: 'nothing', confidence: 0.99 } };
  const r = await verifySanitized(CLEAN, { policy: POLICY });
  assert.equal(r.leaked, false);
  assert.equal(r.what, null);
});

test('a probability below the threshold is not a leak', async () => {
  answers = { leak: { noul: 0.7 }, what: { choice: 'strategic', confidence: 0.6 } };
  const r = await verifySanitized(SANITIZED, { policy: POLICY });
  assert.equal(r.leaked, false, '0.7 is under the 0.8 bar');
  assert.equal(r.probability, 0.7);
});

test('a high probability with nothing named is not a leak', async () => {
  // The two answers disagreeing is a reason for caution, not for action.
  answers = { leak: { noul: 0.95 }, what: { choice: 'nothing', confidence: 0.9 } };
  const r = await verifySanitized(SANITIZED, { policy: POLICY });
  assert.equal(r.leaked, false);
});

test('a failing verification never blocks the request by itself', async () => {
  // It is a second opinion, not the primary control.
  status = 500;
  const r = await verifySanitized(SANITIZED, { policy: POLICY });
  assert.equal(r.degraded, true);
  assert.equal(r.leaked, false);
  assert.match(r.error, /500/);
});

test('policy can switch it off', async () => {
  const r = await verifySanitized(SANITIZED, { policy: { verification: { enabled: false } } });
  assert.equal(r.checked, false);
  assert.equal(lastRequest, null);
  assert.match(r.reason, /disabled/);
});

test('short text is not worth a round trip', async () => {
  const r = await verifySanitized('PERSON_1 called.', { policy: POLICY });
  assert.equal(r.checked, false);
  assert.equal(lastRequest, null);
});
