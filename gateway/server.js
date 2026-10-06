import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, isMock, validateConfig, judgeResidency, judgeModel } from './config.js';
import { adapterForPath } from './proxy/adapters.js';
import { handleProxy, resolveEscalation, sendJson, pendingApprovals, pendingReviews } from './proxy/handler.js';
import { bus, metrics } from './lib/events.js';
import { watchPolicy, getPolicy, policyStatus } from './policy/policy.js';
import { writePolicy, rollbackPolicy } from './policy/write.js';
import * as policyVersions from './policy/versions.js';
import { verifyChain, readRecords, evidenceBundle } from './audit/audit.js';
import { vault } from './vault/vault.js';
import * as accounts from './auth/accounts.js';
import * as session from './auth/session.js';

const DASHBOARD = path.join(ROOT, 'dashboard');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Which paths the console's sign-in protects.
 *
 * Deliberately a short allow-list of what stays open, rather than a list of
 * what is closed. Getting this backwards is how an appliance ends up with an
 * unauthenticated admin endpoint nobody remembered to add to the list.
 *
 * Employee traffic is open and must stay that way. The proxy routes are the
 * product: an employee's client sends a prompt and has no console session, no
 * cookie, and no way to obtain one. Putting the administrator's login in front
 * of them would not secure anything - it would stop the gateway working.
 */
function isOpenPath(pathname) {
  if (/^\/v\d+\//.test(pathname)) return true;          // provider API traffic
  if (pathname.startsWith('/openai/')) return true;       // OpenAI-shaped traffic
  if (pathname.startsWith('/anthropic/')) return true;    // Anthropic-shaped traffic
  if (pathname === '/health') return true;                // load balancers
  if (pathname.startsWith('/api/auth/')) return true;     // signing in, by definition
  // The console's own files. They carry no data; every byte of that is behind
  // /api, and the page shows a sign-in form when the session is missing.
  if (!pathname.startsWith('/api/')) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/auth/')) {
      return await handleAuth({ req, res, url });
    }

    if (!isOpenPath(url.pathname) && !session.sessionFrom(req)) {
      return sendJson(res, 401, {
        error: { type: 'not_signed_in', message: 'This endpoint needs an administrator session.' },
      });
    }

    if (req.method === 'POST') {
      const adapter = adapterForPath(url.pathname);
      if (adapter) {
        const rawBody = await readBody(req);
        return await handleProxy({ adapter, req, res, rawBody });
      }
      if (url.pathname === '/api/policy/rollback') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = policyVersions.read(body.seq);
        if (!text) return sendJson(res, 404, { ok: false, problems: [`no stored version ${body.seq}`] });
        const result = rollbackPolicy(text, { seq: body.seq, by: 'console' });
        return sendJson(res, result.ok ? 200 : 422, { ...result, status: policyStatus() });
      }
      if (url.pathname.startsWith('/api/escalations/')) {
        const id = url.pathname.split('/').pop();
        const body = JSON.parse((await readBody(req)) || '{}');
        const ok = resolveEscalation(id, body.approved === true, body.reviewer || 'dashboard');
        return sendJson(res, ok ? 200 : 404, { ok });
      }
    }

    if (req.method === 'PUT' && new URL(req.url, 'http://x').pathname === '/api/policy') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const edits = Array.isArray(body.edits) ? body.edits : [];
      if (!edits.length) return sendJson(res, 400, { ok: false, problems: ['no edits given'] });
      // 422 rather than 400 on a rejected edit: the request was well formed,
      // the policy it would produce is the thing that is not acceptable.
      const result = writePolicy(edits, { by: body.by ?? 'console', summary: body.summary ?? '' });
      return sendJson(res, result.ok ? 200 : 422, { ...result, status: policyStatus() });
    }

    if (req.method === 'GET') {
      if (url.pathname === '/api/events') return sseEvents(req, res);
      if (url.pathname === '/api/state') return sendJson(res, 200, state());
      if (url.pathname === '/api/policy') {
        return sendJson(res, 200, {
          status: policyStatus(),
          policy: getPolicy(),
          raw: safeRead(config.policyPath),
        });
      }
      if (url.pathname === '/api/escalations') return sendJson(res, 200, pendingReviews(getPolicy()));
      if (url.pathname === '/api/policy/versions') {
        return sendJson(res, 200, { versions: policyVersions.list(50) });
      }
      if (url.pathname === '/api/audit/verify') return sendJson(res, 200, await verifyChain());
      if (url.pathname === '/api/audit') {
        const q = url.searchParams;
        return sendJson(res, 200, await readRecords({
          limit: Math.min(200, Number(q.get('limit')) || 50),
          offset: Math.max(0, Number(q.get('offset')) || 0),
          filter: q.get('filter') ?? '',
          action: q.get('action') ?? '',
        }));
      }
      if (url.pathname === '/api/audit/export') {
        const bundle = await evidenceBundle({ filter: url.searchParams.get('filter') ?? '', action: url.searchParams.get('action') ?? '' });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="hajiz-evidence-${Date.now()}.json"`,
        });
        return res.end(JSON.stringify(bundle, null, 2));
      }
      if (url.pathname === '/health') return sendJson(res, 200, { ok: true, mode: config.upstreamMode });
      // Provider API paths are proxied; everything else is the dashboard.
      if (/^\/v\d+\//.test(url.pathname)) return await passthrough(req, res, url);
      return serveStatic(url.pathname, res);
    }

    // Anything the gateway does not inspect is proxied straight through.
    // A real client calls more than the one endpoint we care about - token
    // counting, model listing, OAuth - and 404ing those breaks it outright.
    if (/^\/v\d+\//.test(url.pathname)) return await passthrough(req, res, url);

    return sendJson(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (err) {
    return sendJson(res, 500, { error: { message: err.message } });
  }
});

/**
 * Transparent proxy for endpoints the gateway does not inspect. Method, path,
 * query, headers and body are preserved; the response is streamed back byte
 * for byte. Recorded on the dashboard so nothing crosses the perimeter
 * silently, even when it is not inspected.
 */
async function passthrough(req, res, url) {
  const target = `${config.upstream.anthropic}${url.pathname}${url.search}`;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (!headers['x-api-key'] && !headers.authorization && process.env.ANTHROPIC_API_KEY) {
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await readBody(req) : undefined;

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body: body || undefined });
  } catch (err) {
    bus.publish({ kind: 'passthrough', method: req.method, path: url.pathname, status: 'error', message: err.message });
    return sendJson(res, 502, { error: { message: `gateway could not reach upstream: ${err.message}` } });
  }

  bus.publish({ kind: 'passthrough', method: req.method, path: url.pathname, status: upstream.status });

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
  });
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  return res.end();
}

function state() {
  return {
    mode: config.upstreamMode,
    enforcement: config.mode,
    judge: {
      provider: config.judge.provider,
      model: judgeModel(),
      effort: config.judge.effort,
      ...judgeResidency(),
    },
    policy: policyStatus(),
    actions: getPolicy().actions,
    // The console shows the gate, the wait and the ratchet limit beside the
    // traffic they explain. Served from the live policy rather than defaulted
    // in the page, so a console that has drifted from policy.yaml says so.
    thresholds: getPolicy().thresholds ?? {},
    escalation: getPolicy().escalation ?? {},
    metrics: metrics.snapshot(),
    vault: vault.stats(),
    pendingEscalations: pendingApprovals.size,
    showsPlaintext: config.dashboardShowPlaintext,
    events: bus.recent(60),
  };
}

function sseEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ kind: 'hello', state: state() })}\n\n`);
  const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
}

/**
 * Signing in, signing out, and telling the console which of those it is.
 *
 * Failures are deliberately vague about which half was wrong: with exactly one
 * account, "no such user" and "wrong password" are the same fact, and saying
 * which would only help someone guessing.
 */
async function handleAuth({ req, res, url }) {
  const secure = Boolean(req.socket.encrypted);

  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    const s = session.sessionFrom(req);
    return sendJson(res, 200, {
      provisioned: accounts.isProvisioned(),
      signedIn: Boolean(s),
      username: s?.username ?? null,
      expiresAt: s?.exp ?? null,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/provision') {
    // Only ever available on an appliance that has no administrator yet.
    if (accounts.isProvisioned()) {
      return sendJson(res, 409, { ok: false, error: 'an administrator already exists' });
    }
    const body = JSON.parse((await readBody(req)) || '{}');
    const result = accounts.provision({ username: body.username || 'admin', password: body.password });
    if (!result.ok) return sendJson(res, 400, result);

    const issued = session.issue({ username: result.username });
    res.setHeader('set-cookie', session.cookieHeader(issued.token, { secure }));
    return sendJson(res, 200, { ok: true, username: result.username, expiresAt: issued.expiresAt });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const result = accounts.verify({ username: body.username, password: body.password });

    if (!result.ok) {
      const status = result.reason === 'locked' ? 429 : 401;
      return sendJson(res, status, {
        ok: false,
        reason: result.reason,
        lockedUntil: result.lockedUntil ?? null,
        remaining: result.remaining ?? null,
        error:
          result.reason === 'locked'
            ? 'Too many failed attempts. Try again later, or reset the password from a shell on the appliance.'
            : result.reason === 'not_provisioned'
              ? 'This appliance has no administrator yet.'
              : 'That username and password do not match.',
      });
    }

    const issued = session.issue({ username: result.username });
    res.setHeader('set-cookie', session.cookieHeader(issued.token, { secure }));
    return sendJson(res, 200, { ok: true, username: result.username, expiresAt: issued.expiresAt });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    res.setHeader('set-cookie', session.clearCookieHeader({ secure }));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: { type: 'not_found', message: 'no such auth route' } });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(DASHBOARD, rel);
  // The console routes client-side, so a deep link like /policy names a page,
  // not a file. A path with no extension falls back to the shell, which then
  // renders the right page. Anything that does name a file still 404s honestly.
  if (!path.extname(rel)) {
    const shell = path.join(DASHBOARD, 'index.html');
    if (fs.existsSync(shell)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return fs.createReadStream(shell).pipe(res);
    }
  }
  if (!file.startsWith(DASHBOARD) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  return fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const safeRead = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

watchPolicy(() => bus.publish({ kind: 'policy_reloaded', status: policyStatus() }));
setInterval(() => vault.sweep(), 60_000).unref();

const configProblem = validateConfig();
if (configProblem) {
  console.error(`\n  Cannot start: ${configProblem}\n`);
  console.error('  PowerShell   $env:DLP_UPSTREAM_MODE="mock"; npm start');
  console.error('  bash         DLP_UPSTREAM_MODE=mock npm start\n');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use — another gateway is probably still running.`);
    console.error('  Start this one on a different port:');
    console.error(`    PowerShell   $env:DLP_PORT=8090; npm start`);
    console.error(`    bash         DLP_PORT=8090 npm start`);
    console.error('  Or find and stop the process holding it:');
    console.error(
      `    PowerShell   Get-NetTCPConnection -LocalPort ${config.port} -State Listen | ` +
        'ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n',
    );
    process.exit(1);
  }
  console.error(`\n  Gateway failed to start: ${err.message}\n`);
  process.exit(1);
});

server.listen(config.port, () => {
  const p = getPolicy();
  console.log(`\n  Hajiz DLP gateway listening on http://localhost:${config.port}`);
  console.log(`  dashboard   http://localhost:${config.port}/`);
  console.log(`  endpoints   POST /v1/messages   POST /v1/chat/completions`);
  console.log(`  policy      ${p.name} (v${p.version})`);
  const jr = judgeResidency();
  console.log(`  judge       ${config.judge.provider}:${judgeModel()} (effort ${config.judge.effort})`);
  console.log(`  residency   ${jr.residency} — ${jr.host}${jr.standIn ? '  [STAND-IN: a hosted model is impersonating an on-prem one]' : ''}`);
  console.log(`  upstream    ${isMock() ? 'MOCK - no network calls' : config.upstream.anthropic}`);
  console.log(`  mode        ${config.mode}${config.mode === 'observe' ? '  (detect and log only - nothing is altered or blocked)' : ''}`);
  if (jr.residency === 'external' && config.judge.provider === 'local' && !config.judge.apiKey) {
    console.warn('  ⚠ judge  the judge host is remote but DLP_JUDGE_API_KEY is not set — every call will fail auth');
  }
  if (vault.stats().ephemeralKey) {
    console.log('  vault       ephemeral key (set DLP_VAULT_KEY to persist mappings across restarts)');
  }
  console.log('');
});

export { server };
