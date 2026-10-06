/*
 * Monitor — the page someone leaves open.
 *
 * Everything here is read from /api/state, which the shell re-pulls on every
 * server-sent event. Nothing on this page is invented: if the gateway has not
 * handled a request yet, it says so rather than showing a plausible number.
 */

const ACTIONS = ['allow', 'pseudonymize', 'redact', 'escalate', 'block'];

const ACTION_NOTE = {
  allow: 'Left unchanged',
  pseudonymize: 'Swapped for placeholders, restored in the reply',
  redact: 'Removed for good, never restored',
  escalate: 'Held for a person',
  block: 'Never left',
};

export function renderMonitor(mount, { store, navigate }) {
  mount.innerHTML = `
    <p class="eyebrow">Monitor · since the gateway started</p>
    <h1 class="display" id="m-headline">Watching for prompts.</h1>
    <p class="lede" id="m-lede">Nothing has passed through yet.</p>

    <div id="m-judge-banner"></div>

    <h2 class="section">Actions taken</h2>
    <div class="card" id="m-actions"></div>

    <div class="grid grid--2" style="margin-top:14px">
      <div class="card">
        <h2 class="section" style="margin:0 0 12px">Detection latency</h2>
        <div id="m-latency"></div>
      </div>
      <div class="card">
        <h2 class="section" style="margin:0 0 12px">How decisions are made</h2>
        <div id="m-decisions"></div>
      </div>
    </div>

    <h2 class="section">What actually left the network</h2>
    <div class="card" id="m-diff"></div>

    <h2 class="section">Recent requests</h2>
    <div class="card" style="padding:18px 8px" id="m-recent"></div>
  `;

  const unsubscribe = store.subscribe((state) => paint(mount, state, navigate));
  return { stop: unsubscribe };
}

function paint(root, state, navigate) {
  const m = state.metrics ?? {};
  const total = m.requests ?? 0;
  const by = m.byAction ?? {};
  const clean = by.allow ?? 0;
  const touched = total - clean;

  root.querySelector('#m-headline').textContent = total
    ? `${total.toLocaleString()} prompt${total === 1 ? '' : 's'} inspected on their way out.`
    : 'Watching for prompts.';

  root.querySelector('#m-lede').textContent = total
    ? `${clean.toLocaleString()} left exactly as written. The other ${touched.toLocaleString()} ` +
      `were pseudonymized, redacted, held for a person or blocked here, on this appliance, ` +
      `before anything reached the assistant.`
    : 'Nothing has passed through yet. Point a client at this gateway and its prompts appear here.';

  paintJudge(root.querySelector('#m-judge-banner'), state);
  paintActions(root.querySelector('#m-actions'), by, total);
  paintLatency(root.querySelector('#m-latency'), m, state);
  paintDecisions(root.querySelector('#m-decisions'), state);
  paintDiff(root.querySelector('#m-diff'), state);
  paintRecent(root.querySelector('#m-recent'), state, navigate);
}

function paintJudge(el, state) {
  const judge = state.judge ?? {};

  // A judge that is not answering is a louder problem than a judge in the wrong
  // place: Tier 1 still runs, so the console keeps filling with green rows and
  // looks healthy while the semantic layer is dead. Say it first.
  const degraded = (state.events ?? []).find((e) => e.kind === 'request' && e.judgeDegraded);
  if (degraded) {
    el.innerHTML = `
      <div class="banner banner--warn">
        <span class="dot dot--off" style="margin-top:5px"></span>
        <span><strong>The semantic judge is not answering.</strong>
        ${esc(degraded.judgeError ?? 'No reason given.')} Tier 1 is still inspecting every prompt, so
        structured identifiers are caught — but nothing is reading for meaning, and this page will look
        healthy regardless.</span>
      </div>`;
    return;
  }

  if (!judge.standIn) {
    el.innerHTML = '';
    return;
  }
  // The judge reading prompt text over a public API is the one thing on this
  // console that undercuts the product's own promise. It is stated plainly
  // rather than buried in a settings page.
  el.innerHTML = `
    <div class="banner banner--warn">
      <span class="dot dot--warn" style="margin-top:5px"></span>
      <span><strong>The semantic judge is an external stand-in.</strong>
      ${esc(judge.model ?? 'unknown model')} answers over
      ${esc(judge.host ?? 'an external API')}, outside your tenant — prompt text leaves the network to be
      judged. Its calls are not production-grade until a judge runs inside your own network.</span>
    </div>`;
}

function paintActions(el, by, total) {
  if (!total) {
    el.innerHTML = `<div class="empty">No requests yet.</div>`;
    return;
  }
  const segments = ACTIONS.map((a) => {
    const n = by[a] ?? 0;
    return n ? `<span style="width:${(n / total) * 100}%;background:var(--${a})"></span>` : '';
  }).join('');

  const cells = ACTIONS.map((a) => {
    const n = by[a] ?? 0;
    const pct = total ? ((n / total) * 100).toFixed(1) : '0.0';
    return `
      <div>
        <div class="stat__label"><span class="pill pill--${a}">${a}</span></div>
        <div class="stat__value">${n.toLocaleString()}</div>
        <div class="stat__note">${pct}% · ${esc(ACTION_NOTE[a])}</div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="bar">${segments}</div>
    <div class="grid" style="grid-template-columns:repeat(5,minmax(0,1fr));margin-top:16px">${cells}</div>`;
}

function paintLatency(el, m, state) {
  const a = m.tierA ?? {};
  const b = m.tierB ?? {};
  const judge = state.judge ?? {};
  const row = (label, note, stats, tag) => `
    <div style="display:flex;align-items:baseline;gap:14px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1">
        <div style="font-weight:600">${label} ${tag ?? ''}</div>
        <div class="stat__note">${note}</div>
      </div>
      <div class="mono" style="font-size:20px">${fmtMs(stats.p50)}</div>
      <div class="mono muted" style="font-size:14px;min-width:84px;text-align:right">p95 ${fmtMs(stats.p95)}</div>
    </div>`;

  el.innerHTML =
    row('Tier 1 · deterministic', `Patterns and checksums · ${(a.n ?? 0).toLocaleString()} prompts`, a) +
    row(
      'Tier 2 · semantic judge',
      `${esc(judge.model ?? 'no judge')} · ${(b.n ?? 0).toLocaleString()} sent to the judge`,
      b,
      judge.standIn ? `<span class="pill pill--escalate" style="margin-left:4px">external</span>` : '',
    ) +
    `<div class="stat__note" style="padding-top:10px">Median for every prompt. Human review time is
     excluded — a reviewer who takes a minute is not latency.</div>`;
}

function paintDecisions(el, state) {
  // These three numbers are the policy, not telemetry. Shown here because the
  // rest of the page cannot be read without them.
  const t = state.thresholds ?? {};
  const esc_ = state.escalation ?? {};
  const item = (value, text) => `
    <div style="display:flex;gap:14px;padding:9px 0;border-bottom:1px solid var(--border)">
      <div class="mono" style="font-size:19px;min-width:62px">${value}</div>
      <div class="stat__note" style="margin:0;flex:1">${text}</div>
    </div>`;

  el.innerHTML =
    item(t.sentence_hot_above ?? '0.50', 'Detection gate. A judge score at or above this counts as a finding and the class action applies.') +
    item(`${Math.round((esc_.wait_for_human_ms ?? 90000) / 1000)} s`, 'How long a held prompt waits for a person in the review queue before the machine decides.') +
    item(`1 of ${esc_.auto_decisions_before_block ?? 3}`, 'Machine decisions in a row. Past the limit every later timeout is refused until a person answers one.') +
    `<div class="stat__note" style="padding-top:10px">Edit these on the
      <a href="/policy" style="color:var(--accent);font-weight:600">Policy</a> page.</div>`;
}

/*
 * In enforce mode there are two texts to compare. In observe mode there is
 * only ever one, because the prompt is forwarded byte for byte on purpose —
 * what the gateway records instead is the spans it *would* have replaced. The
 * panel has to say which of those two things it is showing, or a monitor
 * deployment reads as though it were protecting something.
 */
function paintDiff(el, state) {
  const events = (state.events ?? []).filter((e) => e.kind === 'request' && e.original);
  const event = events.find((e) => (e.mappings ?? []).length) ?? null;

  if (!event) {
    const hidden = state.showsPlaintext === false;
    el.innerHTML = `<div class="empty">${
      hidden
        ? 'Prompt text is not shown on this console. Turn on DLP_DASHBOARD_PLAINTEXT to compare what was written against what was sent.'
        : 'Nothing sensitive has been found yet. When it is, the original and what actually left appear here.'
    }</div>`;
    return;
  }

  const mappings = event.mappings ?? [];
  const observed = event.observed === true || event.sanitized == null;

  const right = observed
    ? `<div class="card card--flat" style="border:1px dashed var(--border-strong)">
         <div class="stat__label">Forwarded <span class="faint">— unchanged, this is observe mode</span></div>
         <pre class="mono" style="white-space:pre-wrap;font-size:12.5px;margin:8px 0 0">${esc(clip(event.original))}</pre>
       </div>`
    : `<div class="card card--flat">
         <div class="stat__label">Forwarded <span class="faint">— left the network</span></div>
         <pre class="mono" style="white-space:pre-wrap;font-size:12.5px;margin:8px 0 0">${esc(clip(event.sanitized))}</pre>
       </div>`;

  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <span class="pill pill--${event.action}">${observed ? `would ${event.action}` : event.action}</span>
      <span class="stat__note" style="margin:0">${mappings.length} value${mappings.length === 1 ? '' : 's'}
        ${observed ? 'would have been replaced' : 'replaced'} ·
        Tier 1 ${fmtMs(event.tierAMs)}${event.tierBRan ? ` · judge ${fmtMs(event.tierBMs)}` : ''}</span>
    </div>
    ${observed ? `<div class="banner banner--info" style="margin-bottom:14px">
      <span><strong>Observe mode.</strong> This prompt was forwarded exactly as written — nothing was
      substituted. The values below are what enforcement would have replaced.</span></div>` : ''}
    <div class="grid grid--2">
      <div class="card card--flat">
        <div class="stat__label">Original prompt <span class="faint">— as the employee wrote it</span></div>
        <pre class="mono" style="white-space:pre-wrap;font-size:12.5px;margin:8px 0 0">${esc(clip(event.original))}</pre>
      </div>
      ${right}
    </div>
    ${mappings.length ? mappingTable(mappings, observed) : ''}`;
}

function mappingTable(mappings, observed) {
  const rows = mappings.map((mp) => {
    const replacement = mp.redacted
      ? `[REDACTED:${esc(mp.cls)}]`
      : mp.token
        ? esc(mp.token)
        : `<span class="faint">—</span>`;
    return `
      <tr>
        <td class="mono">${replacement}</td>
        <td>${esc(mp.cls ?? '')}</td>
        <td class="muted">${esc(mp.detector ?? '')}${mp.tier ? ` · tier ${esc(mp.tier)}` : ''}</td>
        <td class="mono" style="text-align:right">${mp.confidence != null ? Number(mp.confidence).toFixed(2) : ''}</td>
      </tr>`;
  }).join('');

  return `<table class="data" style="margin-top:16px">
    <thead><tr><th>${observed ? 'Would become' : 'Replacement'}</th><th>Class</th><th>Found by</th>
    <th style="text-align:right">Confidence</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="stat__note" style="margin-top:10px">Credentials are redacted, not pseudonymized — nothing
    restores them. Everything else is swapped for a placeholder and put back in the reply.</p>`;
}

function paintRecent(el, state, navigate) {
  const events = (state.events ?? []).filter((e) => e.kind === 'request');
  if (!events.length) {
    el.innerHTML = `<div class="empty">No requests yet.</div>`;
    return;
  }

  const rows = events.slice(0, 30).map((e) => {
    const classes = Object.entries(e.byClass ?? {})
      .map(([cls, n]) => `${cls}${n > 1 ? ` ×${n}` : ''}`)
      .join(', ');
    return `
      <tr>
        <td class="mono faint" style="white-space:nowrap">${time(e.ts)}</td>
        <td class="mono">${esc(e.sessionId ?? 'anon')}</td>
        <td class="muted">${esc(e.group ?? '—')}</td>
        <td>${classes ? esc(classes) : '<span class="faint">nothing found</span>'}</td>
        <td><span class="pill pill--${e.action}">${e.action}</span></td>
        <td class="mono muted" style="text-align:right;white-space:nowrap">
          ${fmtMs(e.tierAMs)}${e.tierBRan ? ` · ${fmtMs(e.tierBMs)}` : ''}</td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="stat__note" style="padding:0 10px 10px">
      Each row shows the session the prompt came from. Employee names appear once an identity source is
      connected on <a href="/integrations" style="color:var(--accent);font-weight:600">Integrations</a>.
    </div>
    <table class="data">
      <thead><tr><th>Time</th><th>Session</th><th>Group</th><th>Found</th><th>Action</th>
      <th style="text-align:right">Tier 1 · judge</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ helpers -

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clip = (s, n = 700) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '');

function fmtMs(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  if (n >= 10) return `${n.toFixed(0)} ms`;
  return `${n.toFixed(2)} ms`;
}
