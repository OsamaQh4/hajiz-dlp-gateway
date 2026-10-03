import crypto from 'node:crypto';
import { config, isMock, isObserve } from '../config.js';
import { detect, SEP } from '../detect/index.js';
import { verifySanitized } from '../detect/tierB/verify.js';
import { adjudicateUnreviewed, recordHumanDecision } from '../detect/tierB/adjudicate.js';
import { decide, getPolicy, watchlistFor } from '../policy/policy.js';
import { vault } from '../vault/vault.js';
import { bus, metrics } from '../lib/events.js';
import { append, summarize } from '../audit/audit.js';
import { SSEParser, serialize } from './sse.js';

/** Separator used to judge every segment of a request in a single pass. */

export const pendingApprovals = new Map();

export function resolveEscalation(id, approved, reviewer = 'dashboard') {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;
  // A human answered, so the ratchet resets.
  recordHumanDecision({ sessionId: pending.sessionId, group: pending.group, policy: getPolicy() });
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
  const result = await detect(segments.map((s) => s.text), { policy, watchlist: watchlistFor(group) });
  const decision = decide(result.findings, { group, judgeDegraded: result.judgeDegraded });

  const timings = { tierAMs: result.tierAMs, tierBMs: result.tierBMs, tierBRan: result.tierBRan };
  const judgeInfo = { model: result.judgeModel, degraded: result.judgeDegraded, error: result.judgeError };
  warnOnJudgeFailure(result);

  // ---- observe mode: watch, record, change nothing -------------------------
  // The decision is computed in full so the dashboard and audit log show
  // exactly what enforcement *would* have done - that is the whole point of a
  // monitor rollout - but the request itself is forwarded untouched.
  if (isObserve()) {
    // Report the spans that *would* have been substituted. Without these the
    // dashboard shows a count and no evidence, which defeats the point of a
    // monitor deployment - you cannot tune a policy against a number.
    const wouldTokenize = decision.toTokenize.concat(decision.blocked).map((f) => ({
      token: null,
      redacted: f.action === 'redact',
      cls: f.cls,
      detector: f.detector,
      tier: f.tier,
      confidence: f.confidence,
      rationale: f.rationale,
      original: joined.slice(f.start, f.end),
    }));

    await finish({
      requestId, sessionId, group, adapter, action: decision.action, decision, timings, judge: judgeInfo,
      started, joined, sanitized: null, mappings: wouldTokenize,
      extra: { skipReason: result.tierBSkipReason, observed: true, wouldHave: decision.action },
    });

    if (isMock()) {
      return body.stream === true
        ? sendMockStream(res, adapter, body, joined, vault.streamContext(sessionId))
        : sendJson(res, 200, adapter.mockReply(body, joined));
    }
    if (!hasCredential(adapter, req)) return missingCredential(res, adapter, requestId, decision);
    try {
      return await relay({ adapter, req, res, body });
    } catch (err) {
      bus.publish({ kind: 'upstream_error', requestId, message: err.message });
      return sendJson(res, 502, { error: { message: `gateway could not reach ${adapter.name}: ${err.message}`, type: 'upstream_error' } });
    }
  }

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
    const verdict = await requestApproval({ requestId, sessionId, group, decision, joined, policy });
    reviewMs = performance.now() - reviewStart;

    if (!verdict.approved) {
      await finish({
        requestId, sessionId, group, adapter, action: 'block',
        decision: { ...decision, reasons: [...decision.reasons, `reviewer ${verdict.reviewer} declined`] },
        timings, judge: judgeInfo, started, joined, sanitized: null, mappings: [],
        escalated, reviewMs,
      });
      const { status, body: errBody } = adapter.errorResponse(
        verdict.auto
          ? `This prompt needed human review, nobody answered, and it was ${verdict.auto.reason}`
          : verdict.reason === 'timeout'
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
  const ambiguous = [];
  for (const range of ranges) {
    const local = decision.toTokenize
      .filter((f) => f.start >= range.start && f.end <= range.end)
      .map((f) => ({ ...f, start: f.start - range.start, end: f.end - range.start }));
    if (!local.length) continue;
    const { text, mappings: m, ambiguousAliases } = vault.tokenize(sessionId, range.segment.text, local);
    range.segment.set(text);
    mappings.push(...m);
    if (ambiguousAliases?.length) ambiguous.push(...ambiguousAliases);
  }

  const sanitized = segments.map((s) => s.text).join(SEP);
  let action = mappings.length ? finalAction : 'allow';

  // Check our own work before forwarding. Substitution removes names; it does
  // not remove facts, and the pipeline had no way to notice the difference.
  let verification = null;
  if (mappings.length && action !== 'block') {
    verification = await verifySanitized(sanitized, { policy });
    if (verification.leaked) {
      const mode = policy.verification?.on_residual_leak ?? 'warn';
      const pct = Math.round((verification.probability ?? 0) * 100);
      decision.reasons.push(
        `sanitized text still reveals ${verification.what ?? 'something non-public'} (${pct}%)`,
      );
      if (mode === 'block') action = 'block';
      else if (mode === 'escalate') action = 'escalate';
    }
  }

  await finish({
    requestId, sessionId, group, adapter, action, decision, timings, judge: judgeInfo,
    started, joined, sanitized, mappings, escalated, reviewMs,
    extra: {
      skipReason: result.tierBSkipReason,
      verification: verification?.checked ? { leaked: verification.leaked, probability: verification.probability, what: verification.what } : undefined,
      // A name we could not attribute to one entity is still in the prompt.
      // Surface it rather than letting an unresolved identity disappear.
      ambiguousAliases: ambiguous.length ? ambiguous.map((a) => a.alias) : undefined,
    },
  });

  // ---- forward -------------------------------------------------------------
  const rehydrate = (t, opts) => vault.rehydrate(sessionId, t, opts);
  const wantsStream = body.stream === true;

  if (isMock()) {
    return wantsStream
      ? sendMockStream(res, adapter, body, sanitized, vault.streamContext(sessionId))
      : sendJson(res, 200, adapter.rehydrateResponse(adapter.mockReply(body, sanitized), rehydrate));
  }

  if (!hasCredential(adapter, req)) return missingCredential(res, adapter, requestId, decision);

  try {
    const upstream = await forward({ adapter, req, body });
    if (wantsStream && upstream.ok && /text\/event-stream/.test(upstream.headers.get('content-type') || '')) {
      return pipeStream(res, upstream, adapter, vault.streamContext(sessionId));
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

function requestApproval({ requestId, sessionId, group, decision, joined, policy, sanitizedPreview }) {
  // Policy is the source of truth, but an explicit env override lets a test run
  // shorten the hold without editing the file an organization owns. Agent
  // traffic cannot tolerate a 90-second pause mid-task.
  const waitMs = process.env.DLP_ESCALATION_TIMEOUT_MS
    ? Number(process.env.DLP_ESCALATION_TIMEOUT_MS)
    : (policy?.escalation?.wait_for_human_ms ?? config.escalationTimeoutMs);

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      pendingApprovals.delete(requestId);

      // Nobody answered. Rather than a blunt fail-closed, let the decision model
      // take the call - under a ratchet that blocks once a run of unreviewed
      // decisions exceeds the administrator's limit.
      const mode = policy?.escalation?.on_timeout ?? 'judge';
      if (mode !== 'judge') {
        const approved = mode === 'allow';
        bus.publish({ kind: 'escalation_resolved', requestId, approved, reviewer: 'timeout' });
        return resolve({ approved, reviewer: 'timeout', reason: 'timeout' });
      }

      const call = await adjudicateUnreviewed({
        sanitized: sanitizedPreview ?? joined,
        decision,
        sessionId,
        group,
        policy,
      });
      bus.publish({
        kind: 'escalation_resolved',
        requestId,
        approved: call.approved,
        reviewer: call.by,
        reason: call.reason,
        consecutive: call.consecutive,
      });
      return resolve({ approved: call.approved, reviewer: call.by, reason: call.reason, auto: call });
    }, waitMs);

    pendingApprovals.set(requestId, { resolve, timer, sessionId, group });
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

/**
 * Fail with something actionable rather than relaying the provider's bare
 * "x-api-key header is required", which says nothing about which layer failed.
 */
function missingCredential(res, adapter, requestId, decision) {
  return sendJson(res, 401, {
    error: {
      type: 'authentication_error',
      message:
        `The gateway is in live mode but has no ${adapter.name} credential. ` +
        'Either give the client one, set ANTHROPIC_API_KEY / OPENAI_API_KEY for the gateway, ' +
        'or run with DLP_UPSTREAM_MODE=mock to demo the full pipeline with no network.',
    },
    dlp: { requestId, inspected: true, findings: decision?.perFinding.length ?? 0 },
  });
}

/** Forward a request and stream the reply back verbatim - no rewriting at all. */
async function relay({ adapter, req, res, body }) {
  const upstream = await forward({ adapter, req, body });
  const headers = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  return res.end();
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

async function pipeStream(res, upstream, adapter, ctx) {
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
        res.write(adapter.rewriteEvent(evt, ctx));
      }
    }
    for (const evt of parser.flush()) res.write(adapter.rewriteEvent(evt, ctx));
    for (const tail of ctx.flushAll()) {
      res.write(serialize({ event: 'dlp_tail', data: JSON.stringify(tail) }));
    }
  } finally {
    res.end();
  }
}

async function sendMockStream(res, adapter, body, sanitized, ctx) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const evt of adapter.mockStream(body, sanitized)) {
    res.write(adapter.rewriteEvent(evt, ctx));
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
