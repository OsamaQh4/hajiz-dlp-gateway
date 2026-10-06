import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from './helpers/console-session.js';

/**
 * End-to-end through the real HTTP server in mock-upstream mode: no API key, no
 * network, but every layer in between is the production path.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajiz-e2e-'));

let child;
let admin;

before(async () => {
  child = spawn(process.execPath, [path.join(root, 'gateway', 'server.js')], {
    env: {
      ...process.env,
      DLP_PORT: String(PORT),
      DLP_UPSTREAM_MODE: 'mock',
      DLP_AUDIT_LOG: path.join(tmp, 'audit.jsonl'),
      DLP_ADMIN_FILE: path.join(tmp, 'admin.json'),
      DLP_SESSION_KEY_FILE: path.join(tmp, 'session.key'),
      DLP_ESCALATION_TIMEOUT_MS: '1500',
      // Pin the judge explicitly and strip every ambient credential. Inheriting
      // the shell's keys would make the suite spend money and depend on the
      // network, and these tests exercise the degraded path on purpose.
      DLP_JUDGE_PROVIDER: 'local',
      DLP_JUDGE_BASE_URL: 'http://127.0.0.1:1/v1',
      DLP_JUDGE_RETRIES: '0',
      DLP_JUDGE_TIMEOUT_MS: '600',
      DLP_JUDGE_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: 'ignore',
  });

  // Keep the last failure: this loop used to report only "gateway did not
  // start", which is what a mistake in the sign-in helper looked like too.
  let lastError = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        // The console API needs an administrator session; sign in once here.
        admin = await signIn(BASE);
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway did not start: ${lastError?.message ?? 'no response on /health'}`);
});

after(() => child?.kill());

const send = (prompt, opts = {}) =>
  fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dlp-session': opts.session || 'test',
      ...(opts.group ? { 'x-dlp-group': opts.group } : {}),
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 256,
      stream: opts.stream === true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

test('PII is pseudonymized on the way out and restored on the way back', async () => {
  const res = await send('Customer Ahmed, ID 1098765439, email a.alotaibi@example.com.sa, re Project Falcon.');
  assert.equal(res.status, 200);
  const json = await res.json();
  const answer = json.content.map((b) => b.text).join('');

  // The mock upstream echoes the placeholders it was given; if rehydration
  // works, the real values are back in the answer the employee sees.
  assert.ok(answer.includes('1098765439'), 'the national ID should be restored for the employee');
  assert.ok(answer.includes('Project Falcon'), 'the codename should be restored for the employee');
});

test('a leaked API key is blocked outright and never forwarded', async () => {
  const res = await send(
    'Why does this fail? apiKey: "sk-ant-api03-Zx8Q2vK9mB4nR7tW1cY6hL0pS5dF3gJ8aE2uI9oP4kN7mQ1wX"',
  );
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error.message, /data policy/i);
  assert.ok(json.dlp.classes.includes('secret'));
});

test('clean prompts pass through untouched', async () => {
  const res = await send('Explain the difference between symmetric and asymmetric encryption in 100 words.');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.match(json.content[0].text, /nothing sensitive/i);
});

test('streaming responses are rehydrated as they arrive', async () => {
  const res = await send('Customer Ahmed, ID 1098765439, asks about Project Falcon again.', { stream: true });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  let text = '';
  for await (const chunk of res.body) {
    const s = new TextDecoder().decode(chunk);
    for (const line of s.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') text += evt.delta.text;
      } catch {
        /* non-JSON frames */
      }
    }
  }

  assert.ok(text.includes('1098765439'), 'placeholders split across SSE deltas must still be restored');
  assert.ok(!/\bID_\d+\b/.test(text), 'no placeholder may leak through to the employee');
});

test('a group override changes the decision for the same prompt', async () => {
  const prompt = 'The latency comes from auth-01.corp.internal, what should I check first in the trace?';
  const strict = await (await send(prompt, { session: 'g1' })).json();
  assert.ok(strict.content[0].text.includes('auth-01.corp.internal'));

  // engineering is allowed to name internal hosts, so nothing is substituted
  const eng = await (await send(prompt, { session: 'g2', group: 'engineering' })).json();
  assert.match(eng.content[0].text, /nothing sensitive/i);
});

test('the escalation queue holds a request until a reviewer answers', async () => {
  const prompt =
    'Draft board talking points: the restructuring removes 140 roles in the Dammam operations centre in March, and it is confidential until the announcement.';
  const pending = send(prompt, { session: 'esc' });

  // Find the pending escalation and approve it, the way the dashboard does.
  let requestId = null;
  for (let i = 0; i < 40 && !requestId; i += 1) {
    const state = await (await admin.fetch(`${BASE}/api/state`)).json();
    requestId = state.events.find((e) => e.kind === 'escalation_pending')?.requestId ?? null;
    if (!requestId) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(requestId, 'an escalation should have been raised');

  await admin.fetch(`${BASE}/api/escalations/${requestId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: true, reviewer: 'test-analyst' }),
  });

  const res = await pending;
  assert.equal(res.status, 200);

  // The reviewer's thinking time must not be counted as gateway latency, and
  // the escalation must still be visible even though the request finally
  // completed as a pseudonymized one.
  const state = await (await admin.fetch(`${BASE}/api/state`)).json();
  const record = state.events.filter((e) => e.kind === 'request' && e.escalated).pop();
  assert.ok(record, 'the completed request should be flagged as escalated');
  assert.equal(record.action, 'pseudonymize');
  assert.ok(record.totalMs < 1000, `gateway time should exclude review time, got ${record.totalMs}ms`);
  assert.ok(record.reviewMs >= 0, 'review time is recorded separately');
  assert.ok(state.metrics.byAction.escalate >= 1, 'the escalation must be counted');
});

test('an unanswered escalation times out closed - the prompt is not sent', async () => {
  const res = await send(
    'Confidential: we are acquiring a competitor next quarter and the diligence is not finished, draft the note.',
    { session: 'esc2' },
  );
  assert.equal(res.status, 400);
});

test('the audit log verifies after a full run', async () => {
  const result = await (await admin.fetch(`${BASE}/api/audit/verify`)).json();
  assert.equal(result.ok, true);
  assert.ok(result.records > 0);
});
