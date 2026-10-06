import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from './helpers/console-session.js';

/**
 * Observe mode must detect everything and change nothing.
 *
 * A fake upstream records exactly what arrived, so these tests assert on the
 * bytes the provider actually received - not on what the gateway claims it
 * sent. That is the only assertion worth making before pointing a live coding
 * agent at this thing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8700 + (process.pid % 200);
const UPSTREAM_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajiz-observe-'));

/** The console API needs an administrator session; set up in `before`. */
let admin;

let gateway;
let upstream;
let received = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'upstream reply' }],
      }));
    });
  });
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

  gateway = spawn(process.execPath, [path.join(root, 'gateway', 'server.js')], {
    env: {
      ...process.env,
      DLP_PORT: String(PORT),
      DLP_MODE: 'observe',
      DLP_UPSTREAM_MODE: 'live',
      DLP_ANTHROPIC_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      DLP_AUDIT_LOG: path.join(tmp, 'audit.jsonl'),
      DLP_ADMIN_FILE: path.join(tmp, 'admin.json'),
      DLP_SESSION_KEY_FILE: path.join(tmp, 'session.key'),
      DLP_JUDGE_PROVIDER: 'local',
      DLP_JUDGE_BASE_URL: 'http://127.0.0.1:1/v1', // unreachable on purpose
      DLP_JUDGE_RETRIES: '0',
      DLP_JUDGE_TIMEOUT_MS: '600',
      DLP_JUDGE_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_API_KEY: 'test-key',
    },
    stdio: 'ignore',
  });

  // Keep the last failure: this loop used to report only "gateway did not
  // start", which is what a mistake in the sign-in helper looked like too.
  let lastError = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        // The console API needs an administrator session; sign in once here.
        admin = await signIn(BASE);
        return;
      }
    } catch (err) { lastError = err; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway did not start: ${lastError?.message ?? 'no response on /health'}`);
});

after(() => {
  gateway?.kill();
  upstream?.close();
});

const SENSITIVE = 'Customer Ahmed, ID 1098765439, email a@b.sa, re Project Falcon on auth-01.corp.internal.';

const send = (prompt) =>
  fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dlp-session': 'observe-test' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: prompt }] }),
  });

test('observe mode forwards the prompt byte-for-byte, unmodified', async () => {
  received = [];
  const res = await send(SENSITIVE);
  assert.equal(res.status, 200);

  assert.equal(received.length, 1, 'exactly one upstream call');
  const forwarded = JSON.parse(received[0].body);
  assert.equal(forwarded.messages[0].content, SENSITIVE, 'the prompt must arrive unchanged');
  assert.ok(!/ID_\d+|PERSON_\d+|PROJECT_\d+/.test(received[0].body), 'no placeholder may appear');
});

test('...while still detecting and recording what it saw', async () => {
  const state = await (await admin.fetch(`${BASE}/api/state`)).json();
  const event = state.events.filter((e) => e.kind === 'request').pop();

  assert.equal(event.observed, true);
  assert.ok(event.findings >= 4, `expected several findings, got ${event.findings}`);
  assert.deepEqual(
    Object.keys(event.byClass).sort(),
    ['email', 'internal_host', 'national_id', 'project'],
  );
  assert.equal(event.wouldHave, 'pseudonymize', 'the dashboard shows what enforcement would have done');
});

test('a request that would be BLOCKED still goes through in observe mode', async () => {
  received = [];
  const secret = 'apiKey: "sk-ant-api03-Zx8Q2vK9mB4nR7tW1cY6hL0pS5dF3gJ8aE2uI9oP4kN7mQ1wX"';
  const res = await send(secret);

  assert.equal(res.status, 200, 'observe mode never blocks');
  assert.equal(received.length, 1);
  assert.ok(received[0].body.includes('sk-ant-api03'), 'the secret is forwarded - that is the point of monitoring');

  const state = await (await admin.fetch(`${BASE}/api/state`)).json();
  const event = state.events.filter((e) => e.kind === 'request').pop();
  assert.equal(event.wouldHave, 'block', 'but the log records that enforcement would have blocked it');
});

test('an escalating prompt is not held for a reviewer in observe mode', async () => {
  // In enforce mode this would block on a human. Observe must never stall a
  // request, or it would hang the agent it is monitoring.
  const started = Date.now();
  const res = await send(
    'Confidential: we are acquiring a competitor next quarter and the diligence is unfinished. Draft the internal note.',
  );
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 5000, 'must not wait on an approval queue');
});

test('uninspected endpoints are proxied through unchanged', async () => {
  received = [];
  const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] }),
  });

  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/v1/messages/count_tokens', 'path preserved');
  assert.equal(JSON.parse(received[0].body).messages[0].content, 'hello');
});

test('passthrough preserves the method and query string', async () => {
  received = [];
  await fetch(`${BASE}/v1/models?limit=5`);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'GET');
  assert.equal(received[0].url, '/v1/models?limit=5');
});

test('the audit chain stays intact across observed and passed-through traffic', async () => {
  const result = await (await admin.fetch(`${BASE}/api/audit/verify`)).json();
  assert.equal(result.ok, true);
});
