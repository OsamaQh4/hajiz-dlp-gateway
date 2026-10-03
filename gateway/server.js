import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, isMock, validateConfig, judgeResidency, judgeModel } from './config.js';
import { adapterForPath } from './proxy/adapters.js';
import { handleProxy, resolveEscalation, sendJson, pendingApprovals } from './proxy/handler.js';
import { bus, metrics } from './lib/events.js';
import { watchPolicy, getPolicy, policyStatus } from './policy/policy.js';
import { verifyChain } from './audit/audit.js';
import { vault } from './vault/vault.js';

const DASHBOARD = path.join(ROOT, 'dashboard');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST') {
      const adapter = adapterForPath(url.pathname);
      if (adapter) {
        const rawBody = await readBody(req);
        return await handleProxy({ adapter, req, res, rawBody });
      }
      if (url.pathname.startsWith('/api/escalations/')) {
        const id = url.pathname.split('/').pop();
        const body = JSON.parse((await readBody(req)) || '{}');
        const ok = resolveEscalation(id, body.approved === true, body.reviewer || 'dashboard');
        return sendJson(res, ok ? 200 : 404, { ok });
      }
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
      if (url.pathname === '/api/audit/verify') return sendJson(res, 200, await verifyChain());
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

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(DASHBOARD, rel);
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
