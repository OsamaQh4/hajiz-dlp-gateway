import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * When the console is given its own port, each listener must refuse the
 * other's traffic.
 *
 * This is the property the separation is for. If the traffic port still served
 * the console API, a firewall rule allowing employees to reach the gateway
 * would also let any of them reach the administrative API, and the split would
 * be decorative. Answering on the wrong port is worse than refusing: it means
 * the deployment is not what the administrator believes it is, and serving the
 * request anyway hides that.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAFFIC = 8300 + (process.pid % 150);
const ADMIN = TRAFFIC + 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajiz-listeners-'));

let child;

before(async () => {
  child = spawn(process.execPath, [path.join(root, 'gateway', 'server.js')], {
    env: {
      ...process.env,
      DLP_PORT: String(TRAFFIC),
      DLP_ADMIN_PORT: String(ADMIN),
      DLP_UPSTREAM_MODE: 'mock',
      DLP_MODE: 'observe',
      DLP_AUDIT_LOG: path.join(tmp, 'audit.jsonl'),
      DLP_ADMIN_FILE: path.join(tmp, 'admin.json'),
      DLP_SESSION_KEY_FILE: path.join(tmp, 'session.key'),
      DLP_JUDGE_PROVIDER: 'local',
      DLP_JUDGE_BASE_URL: 'http://127.0.0.1:1/v1',
      DLP_JUDGE_RETRIES: '0',
      DLP_JUDGE_TIMEOUT_MS: '400',
      DLP_JUDGE_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: 'ignore',
  });

  let lastError = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${ADMIN}/api/auth/status`)).ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway did not start: ${lastError?.message ?? 'no response'}`);
});

after(() => {
  child?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const traffic = (p, init) => fetch(`http://127.0.0.1:${TRAFFIC}${p}`, init);
const admin = (p, init) => fetch(`http://127.0.0.1:${ADMIN}${p}`, init);

const prompt = {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
  body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hello' }] }),
};

test('employee traffic is served on the traffic port', async () => {
  assert.equal((await traffic('/v1/messages', prompt)).status, 200);
});

test('the console and its API are not reachable on the traffic port', async () => {
  // The whole point: a network that can send prompts cannot reach the console.
  assert.equal((await traffic('/api/state')).status, 404);
  assert.equal((await traffic('/api/auth/status')).status, 404);
  assert.equal((await traffic('/api/policy')).status, 404);
  assert.equal((await traffic('/')).status, 404);
});

test('the console is served on the admin port', async () => {
  assert.equal((await admin('/')).status, 200);
  assert.equal((await admin('/api/auth/status')).status, 200);
});

test('employee traffic is refused on the admin port', async () => {
  // An application pointed at the wrong port should fail loudly rather than
  // work, so the mistake is found in testing and not in an audit.
  assert.equal((await admin('/v1/messages', prompt)).status, 404);
});

test('health answers on both, because a load balancer watches both', async () => {
  assert.equal((await traffic('/health')).status, 200);
  assert.equal((await admin('/health')).status, 200);
});

test('the console API still requires a session on its own port', async () => {
  // Separating the ports is defence in depth, not a replacement for signing in.
  assert.equal((await admin('/api/state')).status, 401);
  assert.equal((await admin('/api/policy')).status, 401);
});
