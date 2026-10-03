import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The Jev Tier B provider, against a fake decisions server. No network, no
 * spend, and the assertions are about the request we send and the findings we
 * build from the answers - not about the model's judgement.
 */

const port = 9100 + (process.pid % 300);
process.env.DLP_JUDGE_PROVIDER = 'jev';
process.env.DLP_JEV_ENDPOINT = `http://127.0.0.1:${port}/decisions`;
process.env.DLP_JEV_MODEL = 'fake-jev';
process.env.DLP_JUDGE_API_KEY = 'test-key';
process.env.DLP_JUDGE_TIMEOUT_MS = '2000';

let server;
let lastRequest = null;
let respond = () => ({});

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = JSON.parse(body);
      const answers = respond(lastRequest);
      if (answers === 'ERROR') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"upstream exploded"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => server?.close());
beforeEach(() => {
  lastRequest = null;
  respond = () => ({});
});

const { judgeWithJev, sentences, TAXONOMY } = await import('../gateway/detect/tierB/jev.js');
const { decide, loadPolicy } = await import('../gateway/policy/policy.js');
loadPolicy();

const POLICY = { thresholds: { judge_min_confidence: 0.5, adjudicate_below: 0.9 } };

const TEXT =
  'Customer Ahmed Al-Otaibi reported a login failure this morning on the portal. ' +
  'We are acquiring Saned next quarter and it is not yet public. ' +
  'Please draft a short reply explaining the next steps to the customer.';

test('sentences are split with offsets that still point at their own text', () => {
  const parts = sentences(TEXT);
  assert.equal(parts.length, 3);
  for (const p of parts) assert.equal(TEXT.slice(p.start, p.end), p.text);
});

test('short fragments are not sent as sentences', () => {
  const parts = sentences('Hi. Thanks. ' + 'A genuinely long sentence that carries some actual content here.');
  assert.equal(parts.length, 1);
});

test('two questions per sentence, plus the gate and severity', async () => {
  respond = () => ({});
  await judgeWithJev(TEXT, [], { policy: POLICY });

  const keys = Object.keys(lastRequest.questions);
  assert.ok(keys.includes('gate'));
  assert.ok(keys.includes('severity'));
  assert.equal(keys.filter((k) => k.startsWith('sent_')).length, 3);
  assert.equal(keys.filter((k) => k.startsWith('hot_')).length, 3, 'each sentence is gated before it is classified');
  assert.equal(lastRequest.model, 'fake-jev');
  assert.equal(lastRequest.state.prompt, TEXT);
});

test('every sentence question offers the whole taxonomy plus none', async () => {
  await judgeWithJev(TEXT, [], { policy: POLICY });
  const q = lastRequest.questions.sent_0;
  assert.equal(q.type, 'choice');
  for (const cls of Object.keys(TAXONOMY)) assert.ok(q.criteria[cls], `missing option ${cls}`);
  assert.ok(q.criteria.none);
});

test('a classified sentence becomes a locatable finding, flagged semantic', async () => {
  respond = () => ({
    gate: { noul: 0.97 },
    severity: { score: 3.1, confidence: 0.9 },
    hot_1: { noul: 0.96 },
    sent_1: { choice: 'strategic', confidence: 0.96 },
  });

  const r = await judgeWithJev(TEXT, [], { policy: POLICY });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.cls, 'strategic');
  assert.equal(f.semantic, true);
  assert.equal(TEXT.slice(f.start, f.end), f.text, 'offsets must still resolve');
  assert.match(f.text, /acquiring Saned/);
  assert.equal(r.gate, 0.97);
  assert.equal(r.severity, 3.1);
});

test('sentences answered none, or below the confidence floor, are dropped', async () => {
  respond = () => ({
    hot_0: { noul: 0.9 }, sent_0: { choice: 'none', confidence: 0.99 },
    hot_1: { noul: 0.9 }, sent_1: { choice: 'strategic', confidence: 0.2 },
    hot_2: { noul: 0.9 }, sent_2: { choice: 'none', confidence: 0.95 },
  });
  const r = await judgeWithJev(TEXT, [], { policy: POLICY });
  assert.equal(r.findings.length, 0);
});

test('a cold sentence is not promoted by its classification', async () => {
  // The regression that cost 26.7% clean-prompt false positives: asked only
  // "which class is this", a Choice over twelve sensitive options will pick one
  // for an entirely benign sentence. The gate has to be able to veto that.
  respond = () => ({
    hot_1: { noul: 0.05 },
    sent_1: { choice: 'strategic', confidence: 0.99 },
  });
  const r = await judgeWithJev(TEXT, [], { policy: POLICY });
  assert.equal(r.findings.length, 0, 'classification must not override a cold gate');
});

test('a finding is never more confident than its gate', async () => {
  respond = () => ({ hot_1: { noul: 0.7 }, sent_1: { choice: 'strategic', confidence: 0.99 } });
  const r = await judgeWithJev(TEXT, [], { policy: POLICY });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].confidence, 0.7);
});

test('a class the taxonomy does not define is not invented into a finding', async () => {
  respond = () => ({ hot_1: { noul: 0.95 }, sent_1: { choice: 'definitely_not_a_class', confidence: 0.99 } });
  const r = await judgeWithJev(TEXT, [], { policy: POLICY });
  assert.equal(r.findings.length, 0);
});

test('only low-confidence Tier A hits are re-litigated', async () => {
  const tierA = [
    { start: 0, end: 8, text: 'Customer', cls: 'secret', detector: 'high_entropy_secret', confidence: 0.6, tier: 'A' },
    { start: 9, end: 14, text: 'Ahmed', cls: 'national_id', detector: 'saudi_national_id', confidence: 0.97, tier: 'A' },
  ];
  await judgeWithJev(TEXT, tierA, { policy: POLICY });

  const cands = Object.keys(lastRequest.questions).filter((k) => k.startsWith('cand_'));
  assert.equal(cands.length, 1, 'the checksum-validated hit must not be second-guessed');
  assert.match(lastRequest.questions.cand_0.instructions, /Customer/);
});

test('a Tier A false positive answered none is reported as suppressed', async () => {
  const tierA = [
    { start: 0, end: 8, text: 'Customer', cls: 'secret', detector: 'high_entropy_secret', confidence: 0.6, tier: 'A' },
  ];
  respond = () => ({ cand_0: { choice: 'none', confidence: 0.98 } });

  const r = await judgeWithJev(TEXT, tierA, { policy: POLICY });
  assert.equal(r.suppressed.length, 1);
  assert.equal(r.findings.length, 0);
});

test('an adjudicated Tier A hit keeps its span and gains the new class', async () => {
  const tierA = [
    { start: 9, end: 24, text: 'Ahmed Al-Otaibi', cls: 'secret', detector: 'high_entropy_secret', confidence: 0.6, tier: 'A' },
  ];
  respond = () => ({ cand_0: { choice: 'person', confidence: 0.95 } });

  const r = await judgeWithJev(TEXT, tierA, { policy: POLICY });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].cls, 'person');
  assert.equal(r.findings[0].start, 9);
  assert.equal(r.findings[0].adjudicated, true);
});

test('an upstream failure degrades loudly and finds nothing', async () => {
  respond = () => 'ERROR';
  const r = await judgeWithJev(TEXT, [], { policy: POLICY });
  assert.equal(r.degraded, true);
  assert.match(r.error, /500/);
  assert.equal(r.findings.length, 0);
});

test('nothing worth asking means no request at all', async () => {
  const r = await judgeWithJev('short.', [], { policy: POLICY });
  assert.equal(lastRequest, null);
  assert.equal(r.findings.length, 0);
});

test('policy escalates a semantic finding rather than substituting it', () => {
  // Masking the counterparty leaves the deal visible, so a fact must never be
  // pseudonymized - measured at 96% residual leakage.
  const d = decide([
    { start: 0, end: 60, text: 'x', cls: 'project', detector: 'jev', confidence: 0.95, tier: 'B', semantic: true },
  ]);
  assert.equal(d.action, 'escalate');
  assert.ok(d.reasons.some((r) => /not an identifier/.test(r)));
});

test('an ordinary span of the same class is still pseudonymized', () => {
  const d = decide([
    { start: 0, end: 14, text: 'Project Falcon', cls: 'project', detector: 'watchlist', confidence: 1, tier: 'A' },
  ]);
  assert.equal(d.action, 'pseudonymize');
});
