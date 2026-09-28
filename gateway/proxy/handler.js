import crypto from 'node:crypto';
import { config, isMock } from '../config.js';
import { detect } from '../detect/index.js';
import { decide, getPolicy, watchlistFor } from '../policy/policy.js';
import { vault } from '../vault/vault.js';
import { bus, metrics } from '../lib/events.js';
import { append, summarize } from '../audit/audit.js';
import { SSEParser, serialize } from './sse.js';

/** Separator used to judge every segment of a request in a single pass. */
const SEP = '\n␞\n';

export const pendingApprovals = new Map();

export function resolveEscalation(id, approved, reviewer = 'dashboard') {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;
  pendingApprovals.delete(id);
  clearTimeout(pending.timer);
  pending.resolve({ approved, reviewer });
  bus.publish({ kind: 'escalation_resolved', requestId: id, approved, reviewer });
  return true;
}

export async function handleProxy({ adapter, req, res, rawBody }) {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  const sessionId = header(req, 'x-dlp-session') || header(req, 'x-dlp-user') || 'anon';
  const group = header(req, 'x-dlp-group') || null;

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: 'gateway could not parse the request body as JSON' } });
  }

  const segments = adapter.segments(body);
  const { text: joined, ranges } = joinSegments(segments);

  const policy = getPolicy();
  const result = await detect(joined, { policy, watchlist: watchlistFor(group) });
  const decision = decide(result.findings, { group, judgeDegraded: result.judgeDegraded });

  const timings = { tierAMs: result.tierAMs, tierBMs: result.tierBMs, tierBRan: result.tierBRan };
  const judgeInfo = { model: result.judgeModel, degraded: result.judgeDegraded, error: result.judgeError };
  warnOnJudgeFailure(result);

  // ---- blocked -------------------------------------------------------------
  if (decision.action === 'block') {
    await finish({
      requestId, sessionId, group, adapter, action: 'block', decision, timings, judge: judgeInfo,
      started, joined, sanitized: null, mappings: [],
      extra: { skipReason: result.tierBSkipReason },
    });
    const { status, body: errBody } = adapter.errorResponse(
      blockMessage(decision),
      { requestId, reasons: decision.reasons, classes: [...new Set(decision.blocked.map((f) => f.cls))] },
    );
    return sendJson(res, status, errBody);
  }

  // ---- escalated: hold for a human ----------------------------------------
  let finalAction = decision.action;
  const escalated = decision.action === 'escalate';
  let reviewMs = 0;

  if (escalated) {
    // Time spent waiting for a person is not gateway latency. Measured
    // separately so it never lands in the performance numbers.
    const reviewStart = performance.now();
    const verdict = await requestApproval({ requestId, sessionId, group, decision, joined });
    reviewMs = performance.now() - reviewStart;

    if (!verdict.approved) {
      await finish({
        requestId, sessionId, group, adapter, action: 'block',
        decision: { ...decision, reasons: [...decision.reasons, `reviewer ${verdict.reviewer} declined`] },
        timings, judge: judgeInfo, started, joined, sanitized: null, mappings: [],
        escalated, reviewMs,
      });
      const { status, body: errBody } = adapter.errorResponse(
        verdict.reason === 'timeout'
          ? 'This prompt needed human review and no reviewer responded in time. It was not sent.'
          : 'A reviewer declined this prompt. It was not sent to the AI provider.',
        { requestId, reasons: decision.reasons },
      );
      return sendJson(res, status, errBody);
    }
    finalAction = 'pseudonymize';
  }

  // ---- pseudonymize --------------------------------------------------------
  const mappings = [];
  for (const range of ranges) {
    const local = decision.toTokenize
      .filter((f) => f.start >= range.start && f.end <= range.end)
      .map((f) => ({ ...f, start: f.start - range.start, end: f.end - range.start }));
    if (!local.length) continue;
    const { text, mappings: m } = vault.tokenize(sessionId, range.segment.text, local);
    range.segment.set(text);
    mappings.push(...m);
  }

  const sanitized = segments.map((s) => s.text).join(SEP);
  const action = mappings.length ? finalAction : 'allow';

  await finish({
    requestId, sessionId, group, adapter, action, decision, timings, judge: judgeInfo,
    started, joined, sanitized, mappings, escalated, reviewMs,
    extra: { skipReason: result.tierBSkipReason },
  });

  // ---- forward -------------------------------------------------------------
  const rehydrate = (t) => vault.rehydrate(sessionId, t);
  const wantsStream = body.stream === true;

  if (isMock()) {
    return wantsStream
      ? sendMockStream(res, adapter, body, sanitized, vault.streamRehydrator(sessionId))
      : sendJson(res, 200, adapter.rehydrateResponse(adapter.mockReply(body, sanitized), rehydrate));
  }

  if (!hasCredential(adapter, req)) {
    // Fail here with something actionable rather than relaying the provider's
    // bare "x-api-key header is required", which says nothing about the gateway.
    return sendJson(res, 401, {
      error: {
        type: 'authentication_error',
        message:
          `The gateway is in live mode but has no ${adapter.name} credential. ` +
          'Either give the client one, set ANTHROPIC_API_KEY / OPENAI_API_KEY for the gateway, ' +
          'or run with DLP_UPSTREAM_MODE=mock to demo the full pipeline with no network.',
      },
      dlp: { requestId, inspected: true, action, findings: decision.perFinding.length },
    });
  }

  try {
    const upstream = await forward({ adapter, req, body });
    if (wantsStream && upstream.ok && /text\/event-stream/.test(upstream.headers.get('content-type') || '')) {
      return pipeStream(res, upstream, adapter, vault.streamRehydrator(sessionId));
    }
    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return sendRaw(res, upstream.status, upstream.headers.get('content-type') || 'text/plain', rehydrate(text));
    }
    return sendJson(res, upstream.status, upstream.ok ? adapter.rehydrateResponse(payload, rehydrate) : payload);
  } catch (err) {
    bus.publish({ kind: 'upstream_error', requestId, message: err.message });
    return sendJson(res, 502, {
      error: { message: `gateway could not reach the ${adapter.name} API: ${err.message}`, type: 'upstream_error' },
    });
  }
}

// ---------------------------------------------------------------------------

function joinSegments(segments) {
  const ranges = [];
  let text = '';
  for (const segment of segments) {
    if (text) text += SEP;
    const start = text.length;
    text += segment.text ?? '';
    ranges.push({ segment, start, end: text.length });
  }
  return { text, ranges };
}

function blockMessage(decision) {
  const classes = [...new Set(decision.blocked.map((f) => f.cls))];
  const what = classes.length ? classes.join(', ') : 'sensitive content';
  return (
    `Blocked by your organization's AI data policy: this prompt contains ${what}. ` +
    'It was not sent to the AI provider. Remove the sensitive values, or ask your security team for an exception.'
  );
}

function requestApproval({ requestId, sessionId, group, decision, joined }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      bus.publish({ kind: 'escalation_resolved', requestId, approved: false, reviewer: 'timeout' });
      resolve({ approved: false, reviewer: 'timeout', reason: 'timeout' });
    }, config.escalationTimeoutMs);

    pendingApprovals.set(requestId, { resolve, timer });
    bus.publish({
      kind: 'escalation_pending',
      requestId,
      sessionId,
      group,
      expiresAt: Date.now() + config.escalationTimeoutMs,
      reasons: decision.reasons,
      findings: decision.perFinding
        .filter((f) => f.action === 'escalate')
        .map((f) => ({
          cls: f.cls,
          detector: f.detector,
          confidence: f.confidence,
          rationale: f.rationale,
          preview: config.dashboardShowPlaintext ? joined.slice(f.start, f.end) : null,
        })),
    });
  });
}

async function finish({
  requestId, sessionId, group, adapter, action, decision, timings, judge, started, joined, sanitized, mappings,
  escalated = false, reviewMs = 0, extra = {},
}) {
  // Human review time is excluded: a reviewer who takes 40 seconds to click
  // approve must not show up as 40 seconds of gateway latency.
  const totalMs = round2(performance.now() - started - reviewMs);
  metrics.record({ action, escalated, tierAMs: timings.tierAMs, tierBMs: timings.tierBMs, totalMs });

  const record = summarize({
    requestId, sessionId, group, route: adapter.route, action, decision, timings, judge,
  });
  const shared = { ...record, totalMs, escalated, reviewMs: escalated ? round2(reviewMs) : null, ...extra };
  await append(shared);

  bus.publish({
    kind: 'request',
    ...shared,
    // Demo-only: the pre-sanitization text. Off in production (see config).
    original: config.dashboardShowPlaintext ? joined : null,
    sanitized: config.dashboardShowPlaintext ? sanitized : null,
    mappings: mappings.map((m) => ({
      token: m.token,
      cls: m.cls,
      detector: m.detector,
      tier: m.tier,
      confidence: m.confidence,
      rationale: m.rationale,
      original: config.dashboardShowPlaintext ? m.original : null,
    })),
  });
}

let lastJudgeError = null;

/**
 * A judge that silently falls back to heuristics looks like a working system in
 * the dashboard while the semantic layer is dead. Say it on the console, once
 * per distinct error, so it cannot be missed during a demo.
 */
function warnOnJudgeFailure({ judgeDegraded, judgeError }) {
  if (!judgeDegraded || !judgeError) return;
  if (judgeError === lastJudgeError) return;
  lastJudgeError = judgeError;
  console.warn(`\n  ⚠ semantic judge unavailable — falling back to degraded cues\n    ${judgeError}\n`);
}

function hasCredential(adapter, req) {
  if (header(req, 'x-api-key') || header(req, 'authorization')) return true;
  return adapter.name === 'anthropic'
    ? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
    : Boolean(process.env.OPENAI_API_KEY);
}

async function forward({ adapter, req, body }) {
  const url = `${adapter.upstreamBase()}${adapter.upstreamPath}`;
  const headers = { 'content-type': 'application/json' };

  const passthrough = ['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta', 'openai-organization'];
  for (const h of passthrough) {
    const v = req.headers[h];
    if (v) headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }

  // Convenience for demos and for API-gateway mode, where the caller may hold
  // no provider credential at all and the gateway owns it.
  if (adapter.name === 'anthropic') {
    if (!headers['x-api-key'] && !headers.authorization && process.env.ANTHROPIC_API_KEY) {
      headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
    }
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  } else if (!headers.authorization && process.env.OPENAI_API_KEY) {
    headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  }

  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function pipeStream(res, upstream, adapter, rehydrator) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
        res.write(adapter.rewriteEvent(evt, rehydrator));
      }
    }
    for (const evt of parser.flush()) res.write(adapter.rewriteEvent(evt, rehydrator));
    const tail = rehydrator.flush();
    if (tail) res.write(serialize({ event: 'dlp_tail', data: JSON.stringify({ text: tail }) }));
  } finally {
    res.end();
  }
}

async function sendMockStream(res, adapter, body, sanitized, rehydrator) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const evt of adapter.mockStream(body, sanitized)) {
    res.write(adapter.rewriteEvent(evt, rehydrator));
    await new Promise((r) => setTimeout(r, 12));
  }
  res.end();
}

const round2 = (n) => Math.round(n * 100) / 100;

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendRaw(res, status, contentType, text) {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}
