import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A chat client resends the whole conversation every turn. Without caching,
 * turn N pays to judge all N messages - quadratic in the length of the
 * conversation, and unusable for a real coding agent. These tests assert on
 * how much text actually reached the model.
 */

const port = 8900 + (process.pid % 300);
process.env.DLP_JUDGE_PROVIDER = 'local';
process.env.DLP_JUDGE_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.DLP_JUDGE_MODEL = 'fake';
process.env.DLP_JUDGE_API_KEY = 'k';

let server;
let calls = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body);
      // Strip the judge's prompt wrapper so tests measure the text actually
      // being judged, not the fixed scaffolding around it.
      const wrapped = payload.messages[1].content;
      const state = wrapped.match(/<content_to_classify>\n([\s\S]*?)\n<\/content_to_classify>/)?.[1] ?? wrapped;
      calls.push(state);
      const findings = [];
      // Report any "Project <Name>" span, so findings are attributable to a
      // specific message rather than to the joined blob.
      for (const m of state.matchAll(/Project [A-Z][a-z]+/g)) {
        findings.push({ text: m[0], cls: 'project', confidence: 0.9, rationale: 'codename' });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ has_sensitive: findings.length > 0, overall_confidence: 0.9, findings }) } }],
      }));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => server?.close());

const { detect } = await import('../gateway/detect/index.js');
const cacheModule = await import('../gateway/detect/tierB/cache.js');

const POLICY = { tier_b: { enabled: true, min_chars: 20, min_words: 4 }, thresholds: { judge_min_confidence: 0.5 } };

beforeEach(() => {
  calls = [];
  cacheModule.clear();
});

const LONG_A = 'The first message discusses Project Falcon and its rollout plan in some detail for the team.';
const LONG_B = 'A second message about Project Condor and the migration timeline that follows from it.';
const LONG_C = 'A third message covering Project Heron and the procurement steps still outstanding.';

test('the first turn judges everything it is given', async () => {
  const r = await detect([LONG_A], { policy: POLICY });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('Project Falcon'));
  assert.equal(r.tierBRan, true);
  assert.equal(r.findings.filter((f) => f.tier === 'B').length, 1);
});

test('a resent conversation only sends the new message to the judge', async () => {
  await detect([LONG_A], { policy: POLICY });
  calls = [];

  // Turn two: the client resends message one and adds message two.
  const r = await detect([LONG_A, LONG_B], { policy: POLICY });

  assert.equal(calls.length, 1, 'one judge call');
  assert.ok(!calls[0].includes('Project Falcon'), 'the already-judged message must not be resent');
  assert.ok(calls[0].includes('Project Condor'), 'only the new message is judged');
  assert.equal(r.reusedFindings, 1, 'the earlier finding is reused from cache');
  assert.equal(r.findings.filter((f) => f.tier === 'B').length, 2, 'both findings are still reported');
});

test('offsets stay correct for findings reused from cache', async () => {
  await detect([LONG_A], { policy: POLICY });
  const r = await detect([LONG_A, LONG_B], { policy: POLICY });

  const joined = [LONG_A, LONG_B].join('\n␞\n');
  for (const f of r.findings.filter((x) => x.tier === 'B')) {
    assert.equal(joined.slice(f.start, f.end), f.text, 'a cached span must still point at its own text');
  }
});

test('a turn that adds nothing new skips Tier B entirely', async () => {
  await detect([LONG_A, LONG_B], { policy: POLICY });
  calls = [];

  const r = await detect([LONG_A, LONG_B], { policy: POLICY });
  assert.equal(calls.length, 0, 'no judge call at all');
  assert.equal(r.tierBRan, false);
  assert.match(r.tierBSkipReason, /already judged/);
  assert.equal(r.findings.filter((f) => f.tier === 'B').length, 2, 'findings still come back');
});

test('cost grows with new text, not with conversation length', async () => {
  let totalJudged = 0;
  const conversation = [];
  for (const msg of [LONG_A, LONG_B, LONG_C]) {
    conversation.push(msg);
    calls = [];
    await detect([...conversation], { policy: POLICY });
    totalJudged += calls.join('').length;
  }

  const everyMessageOnce = LONG_A.length + LONG_B.length + LONG_C.length;
  // Without caching this would be A + (A+B) + (A+B+C) - roughly double.
  assert.ok(
    totalJudged < everyMessageOnce * 1.2,
    `judged ${totalJudged} chars; each message once is ${everyMessageOnce}`,
  );
});

test('a degraded judgement is not cached, so an outage does not stick', async () => {
  process.env.DLP_JUDGE_BASE_URL = 'http://127.0.0.1:1/v1'; // unreachable
  const { config } = await import('../gateway/config.js');
  const previous = config.judge.baseUrl;
  config.judge.baseUrl = 'http://127.0.0.1:1/v1';
  config.judge.retries = 0;
  config.judge.timeoutMs = 500;

  const bad = await detect([LONG_A], { policy: POLICY });
  assert.equal(bad.judgeDegraded, true);

  config.judge.baseUrl = previous;
  calls = [];
  const good = await detect([LONG_A], { policy: POLICY });
  assert.equal(calls.length, 1, 'the failed judgement must not have been cached');
  assert.equal(good.judgeDegraded, false);
});

test('cache statistics are reported', async () => {
  await detect([LONG_A], { policy: POLICY });
  const r = await detect([LONG_A], { policy: POLICY });
  assert.ok(r.cache.hits >= 1);
  assert.ok(r.cache.entries >= 1);
});
