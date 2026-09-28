import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The on-prem judge path, exercised against a stand-in OpenAI-compatible server.
 * Small open models are messy: they wrap JSON in markdown, write prose around
 * it, use "class" instead of "cls", and some servers reject response_format
 * outright. All of that has to survive.
 */

// config.js reads the environment at import time, so the judge has to be
// pointed at the fake server before anything imports it.
const port = 8300 + (process.pid % 300);
process.env.DLP_JUDGE_PROVIDER = 'local';
process.env.DLP_JUDGE_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.DLP_JUDGE_MODEL = 'google/gemma-4-26b-a4b-it:free';
process.env.DLP_JUDGE_API_KEY = 'test-key';

let server;
let lastRequest = null;
let behavior = 'clean';
let attempts = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = JSON.parse(body);
      attempts += 1;

      // Throttles on the first call only, then succeeds - the case a retry fixes.
      if (behavior === 'rate_limited_once' && attempts === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      }
      if (behavior === 'always_429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      }

      if (behavior === 'rejects_response_format' && lastRequest.response_format) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
      }

      const content = {
        rate_limited_once:
          '{"has_sensitive":true,"overall_confidence":0.8,"findings":[{"text":"acquiring Saned","cls":"strategic","confidence":0.8,"rationale":"retry succeeded"}]}',
        clean: '{"has_sensitive":true,"overall_confidence":0.8,"findings":[{"text":"acquiring Saned","cls":"strategic","confidence":0.8,"rationale":"undisclosed M&A"}]}',
        rejects_response_format:
          '{"has_sensitive":true,"overall_confidence":0.7,"findings":[{"text":"acquiring Saned","cls":"strategic","confidence":0.7,"rationale":"deal talk"}]}',
        fenced:
          'Sure! Here is my analysis:\n\n```json\n{"has_sensitive": true, "overall_confidence": 0.9,\n "findings": [{"text": "acquiring Saned", "class": "strategic", "confidence": 0.9, "rationale": "not yet public"}]}\n```\n\nLet me know if you need more.',
        wrong_class:
          '{"has_sensitive":true,"overall_confidence":0.6,"findings":[{"text":"acquiring Saned","cls":"merger_and_acquisition","confidence":0.6,"rationale":"invented category"}]}',
        garbage: 'I am not going to answer that.',
        empty_findings: '{"has_sensitive":false,"overall_confidence":0.1,"findings":[]}',
      }[behavior];

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => server?.close());

const { judge, extractJson, normalizeJudgeOutput } = await import('../gateway/detect/tierB/judge.js');
const { judgeResidency } = await import('../gateway/config.js');

const TEXT = 'Board note: we are acquiring Saned next quarter and it is not yet public.';

test('the local judge returns located spans from a well-behaved server', async () => {
  behavior = 'clean';
  const result = await judge(TEXT);
  assert.equal(result.degraded, false, result.error || '');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].cls, 'strategic');
  assert.equal(TEXT.slice(result.findings[0].start, result.findings[0].end), 'acquiring Saned');
});

test('the request goes to the configured on-prem server, with its own credential', () => {
  assert.equal(lastRequest.model, 'google/gemma-4-26b-a4b-it:free');
  assert.equal(lastRequest.temperature, 0);
  assert.ok(lastRequest.messages[1].content.includes('<content_to_classify>'));
});

test('a server that rejects response_format gets a retry without it', async () => {
  behavior = 'rejects_response_format';
  const result = await judge(TEXT);
  assert.equal(result.degraded, false, result.error || '');
  assert.equal(result.findings.length, 1);
  assert.equal(lastRequest.response_format, undefined, 'the retry must omit response_format');
});

test('JSON wrapped in a markdown fence and prose is still parsed', async () => {
  behavior = 'fenced';
  const result = await judge(TEXT);
  assert.equal(result.degraded, false, result.error || '');
  assert.equal(result.findings[0].cls, 'strategic', 'a "class" key must be read as "cls"');
});

test('an invented category is kept as "other" rather than dropped', async () => {
  behavior = 'wrong_class';
  const result = await judge(TEXT);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].cls, 'other');
});

test('a refusal or non-JSON reply degrades loudly instead of passing as clean', async () => {
  behavior = 'garbage';
  const result = await judge(TEXT);
  assert.equal(result.degraded, true);
  assert.equal(result.model, 'heuristic');
  assert.match(result.error, /JSON/i);
});

test('an honest "nothing here" is respected', async () => {
  behavior = 'empty_findings';
  const result = await judge('What is the capital of France?');
  assert.equal(result.degraded, false, result.error || '');
  assert.equal(result.findings.length, 0);
});

test('a transient 429 is retried rather than degrading the request', async () => {
  behavior = 'rate_limited_once';
  attempts = 0;
  const result = await judge(TEXT);
  assert.equal(result.degraded, false, result.error || '');
  assert.equal(attempts, 2, 'the first call throttles, the second succeeds');
  assert.equal(result.findings.length, 1);
});

test('persistent throttling gives up after the configured retries and says why', async () => {
  behavior = 'always_429';
  attempts = 0;
  const result = await judge(TEXT);
  assert.equal(result.degraded, true);
  assert.match(result.error, /429/);
  // retries=2 means three attempts in total, not an unbounded loop.
  assert.equal(attempts, 3);
});

test('a 400 retry does not consume a rate-limit retry budget', async () => {
  behavior = 'rejects_response_format';
  attempts = 0;
  const result = await judge(TEXT);
  assert.equal(result.degraded, false, result.error || '');
  assert.equal(attempts, 2, 'one rejected call plus one plain call');
});

test('extractJson handles fences, prose and nested braces', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('noise ```json\n{"a":{"b":2}}\n``` more'), { a: { b: 2 } });
  assert.deepEqual(extractJson('Here: {"a":"}"} done'), { a: '}' }, 'braces inside strings must not end the scan');
  assert.throws(() => extractJson('no object here'));
  assert.throws(() => extractJson('{"unterminated": '));
});

test('normalizeJudgeOutput tolerates missing fields', () => {
  const out = normalizeJudgeOutput({ findings: [{ text: 'x', class: 'person' }] });
  assert.equal(out.has_sensitive, true);
  assert.equal(out.findings[0].cls, 'person');
  assert.equal(out.findings[0].confidence, 0.5);
});

test('a judge on a public host is reported as a stand-in, not as in-tenant', () => {
  const here = judgeResidency();
  assert.equal(here.residency, 'in-tenant', '127.0.0.1 is in-tenant');
  assert.equal(here.standIn, false);
});
