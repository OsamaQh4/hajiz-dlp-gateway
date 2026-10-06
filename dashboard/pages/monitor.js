/*
 * Monitor — the page someone leaves open all day.
 *
 * Laid out as a console, not an article: the page name is in the top bar, the
 * numbers are a strip, and the request log gets the room. An earlier version
 * opened with a 38px headline restating the page you had just clicked on and
 * two lines of prose below it, which is a third of a screen spent telling an
 * operator something they already knew.
 *
 * Everything is read from /api/state, which the shell re-pulls on each
 * server-sent event. Nothing here is invented: with no traffic it says so.
 */

const ACTIONS = ['allow', 'pseudonymize', 'redact', 'escalate', 'block'];

export function renderMonitor(mount, { store }) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">Monitor</h1>
      <span class="toolbar__sub" id="mo-window">since the gateway started</span>
      <span class="pagehead__spacer"></span>
      <input class="search" id="mo-filter" placeholder="Filter by class, action or session" />
      <select class="field field--text" id="mo-action" style="height:28px;width:120px">
        <option value="">All actions</option>
        ${ACTIONS.map((a) => `<option value="${a}">${a}</option>`).join('')}
      </select>
    </div>

    <div id="mo-alert"></div>
    <div class="metrics" id="mo-metrics"></div>

    <div class="split" style="margin-top:12px">
      <div>
        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">Requests</span>
            <span class="panel__spacer"></span>
            <span class="panel__title" id="mo-count" style="text-transform:none;letter-spacing:0"></span>
          </div>
          <div class="panel__body panel__body--flush" id="mo-log"></div>
        </div>

        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">What left the network</span>
            <span class="panel__spacer"></span>
            <span class="panel__title" id="mo-diff-meta" style="text-transform:none;letter-spacing:0"></span>
          </div>
          <div class="panel__body" id="mo-diff"></div>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Detection</span></div>
          <div class="panel__body panel__body--flush" id="mo-detect"></div>
        </div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">In force</span></div>
          <div class="panel__body panel__body--flush" id="mo-policy"></div>
        </div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Judge</span></div>
          <div class="panel__body panel__body--flush" id="mo-judge"></div>
        </div>
      </div>
    </div>`;

  let filter = '';
  let actionFilter = '';
  let latest = null;

  mount.querySelector('#mo-filter').addEventListener('input', (e) => {
    filter = e.target.value.trim().toLowerCase();
    if (latest) paintLog(mount, latest, filter, actionFilter);
  });
  mount.querySelector('#mo-action').addEventListener('change', (e) => {
    actionFilter = e.target.value;
    if (latest) paintLog(mount, latest, filter, actionFilter);
  });

  const unsubscribe = store.subscribe((state) => {
    latest = state;
    paintAlert(mount.querySelector('#mo-alert'), state);
    paintMetrics(mount.querySelector('#mo-metrics'), state);
    paintDetect(mount.querySelector('#mo-detect'), state);
    paintPolicy(mount.querySelector('#mo-policy'), state);
    paintJudge(mount.querySelector('#mo-judge'), state);
    paintLog(mount, state, filter, actionFilter);
    paintDiff(mount, state);
  });

  return { stop: unsubscribe };
}

function paintAlert(el, state) {
  const degraded = (state.events ?? []).find((e) => e.kind === 'request' && e.judgeDegraded);
  if (degraded) {
    el.innerHTML = `<div class="banner banner--warn banner--slim">
      <span class="dot dot--off" style="margin-top:4px"></span>
      <span><strong>Judge not answering.</strong> ${esc(degraded.judgeError ?? '')} Tier 1 still inspects
      every prompt, so this page keeps filling — but nothing is reading for meaning.</span></div>`;
    return;
  }
  if (state.enforcement !== 'enforce') {
    el.innerHTML = `<div class="banner banner--info banner--slim">
      <span><strong>Observe mode.</strong> Prompts are inspected and recorded, and forwarded byte for byte.
      The actions below are what enforcement would have done.</span></div>`;
    return;
  }
  el.innerHTML = '';
}

function paintMetrics(el, state) {
  const m = state.metrics ?? {};
  const by = m.byAction ?? {};
  const total = m.requests ?? 0;

  el.innerHTML =
    `<div><div class="metric__label">Inspected</div>
       <div class="metric__value">${total.toLocaleString()}</div>
       <div class="metric__note">${(m.tierBCalls ?? 0).toLocaleString()} reached the judge</div></div>` +
    ACTIONS.map((a) => {
      const n = by[a] ?? 0;
      const pct = total ? ((n / total) * 100).toFixed(1) : '0.0';
      return `<div>
        <div class="metric__label"><span class="pill pill--${a}">${a}</span></div>
        <div class="metric__value">${n.toLocaleString()}</div>
        <div class="metric__note">${pct}%</div></div>`;
    }).join('');
}

function paintDetect(el, state) {
  const m = state.metrics ?? {};
  const a = m.tierA ?? {};
  const b = m.tierB ?? {};
  el.innerHTML = `
    <div class="row"><div class="row__label"><strong>Tier 1 · deterministic</strong>
      <div class="row__help">Patterns and checksums, every prompt</div></div>
      <span class="mono">${fmtMs(a.p50)}</span></div>
    <div class="row"><div class="row__label"><strong>Tier 1 · p95</strong></div>
      <span class="mono muted">${fmtMs(a.p95)}</span></div>
    <div class="row"><div class="row__label"><strong>Tier 2 · judge</strong>
      <div class="row__help">${(b.n ?? 0).toLocaleString()} prompts sent</div></div>
      <span class="mono">${fmtMs(b.p50)}</span></div>
    <div class="row"><div class="row__label"><strong>Tier 2 · p95</strong></div>
      <span class="mono muted">${fmtMs(b.p95)}</span></div>
    <div class="row"><div class="row__label"><strong>Vault</strong>
      <div class="row__help">Live placeholder mappings</div></div>
      <span class="mono muted">${(state.vault?.tokens ?? 0).toLocaleString()} in ${(state.vault?.sessions ?? 0).toLocaleString()}</span></div>`;
}

function paintPolicy(el, state) {
  const t = state.thresholds ?? {};
  const e = state.escalation ?? {};
  el.innerHTML = `
    <div class="row"><div class="row__label"><strong>Detection gate</strong>
      <div class="row__help">Judge score at or above this acts</div></div>
      <span class="mono">${t.sentence_hot_above ?? '—'}</span></div>
    <div class="row"><div class="row__label"><strong>Wait for a person</strong></div>
      <span class="mono">${e.wait_for_human_ms ? `${Math.round(e.wait_for_human_ms / 1000)}s` : '—'}</span></div>
    <div class="row"><div class="row__label"><strong>Machine decisions in a row</strong></div>
      <span class="mono">${e.auto_decisions_before_block ?? '—'}</span></div>
    <div class="row"><div class="row__label"><strong>Policy</strong>
      <div class="row__help">${esc(state.policy?.name ?? '')}</div></div>
      <a class="btn btn--sm" href="/policy">Edit</a></div>`;
}

function paintJudge(el, state) {
  const j = state.judge ?? {};
  el.innerHTML = `
    <div class="row"><div class="row__label"><strong>${esc(j.model ?? 'none')}</strong>
      <div class="row__help">${esc(j.provider ?? '')}</div></div></div>
    <div class="row"><div class="row__label"><strong>Residency</strong>
      <div class="row__help">${j.standIn ? 'Prompt text leaves the network to be judged' : 'Inside your network'}</div></div>
      <span class="pill pill--${j.standIn ? 'escalate' : 'allow'}">${j.standIn ? 'external' : 'in-tenant'}</span></div>
    ${j.host ? `<div class="row"><div class="row__label"><strong>Host</strong></div>
      <span class="mono muted">${esc(j.host)}</span></div>` : ''}`;
}

function paintLog(mount, state, filter, actionFilter) {
  const el = mount.querySelector('#mo-log');
  let events = (state.events ?? []).filter((e) => e.kind === 'request');

  if (actionFilter) events = events.filter((e) => e.action === actionFilter);
  if (filter) {
    events = events.filter((e) =>
      [e.sessionId, e.group, e.action, Object.keys(e.byClass ?? {}).join(' '), e.detectors]
        .join(' ')
        .toLowerCase()
        .includes(filter));
  }

  mount.querySelector('#mo-count').textContent =
    `${events.length} shown${state.metrics?.requests ? ` of ${state.metrics.requests}` : ''}`;

  if (!events.length) {
    const filtered = (state.metrics?.requests ?? 0) > 0;
    el.innerHTML = filtered
      ? `<div class="empty">Nothing matches that filter.</div>`
      : `<div class="emptyState">
          <div class="orb" style="--orb-a:#2d6a4f;--orb-b:#6aa6d6"></div>
          <div class="emptyState__body">
            <p class="emptyState__title">Nothing has passed through yet</p>
            <p class="emptyState__text">Point a client at this gateway and every prompt it sends appears
            here, with what was found in it and what happened as a result.</p>
          </div></div>`;
    return;
  }

  const rows = events.slice(0, 60).map((e) => {
    const classes = Object.entries(e.byClass ?? {})
      .map(([cls, n]) => `${cls}${n > 1 ? `×${n}` : ''}`)
      .join(' ');
    return `<tr class="hoverable">
      <td class="mono faint" style="white-space:nowrap">${time(e.ts)}</td>
      <td class="mono">${esc(e.sessionId ?? 'anon')}</td>
      <td class="muted">${esc(e.group ?? '—')}</td>
      <td>${classes ? esc(classes) : '<span class="faint">—</span>'}</td>
      <td class="muted">${esc(clip(e.detectors ?? '', 34))}</td>
      <td><span class="pill pill--${e.action}">${e.action}</span></td>
      <td class="mono muted" style="text-align:right;white-space:nowrap">${fmtMs(e.tierAMs)}${
        e.tierBRan ? ` · ${fmtMs(e.tierBMs)}` : ''
      }</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<table class="data data--dense">
    <thead><tr><th>Time</th><th>Session</th><th>Group</th><th>Found</th><th>Detectors</th>
    <th>Action</th><th style="text-align:right">T1 · judge</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="row" style="border-top:1px solid var(--border);border-bottom:0">
      <div class="row__help">Sessions, not people. Names appear once an identity source is connected on
      <a href="/integrations" style="color:var(--accent)">Integrations</a>.</div></div>`;
}

function paintDiff(mount, state) {
  const el = mount.querySelector('#mo-diff');
  const meta = mount.querySelector('#mo-diff-meta');
  const event = (state.events ?? []).find((e) => e.kind === 'request' && e.original && (e.mappings ?? []).length);

  if (!event) {
    meta.textContent = '';
    el.innerHTML = `<div class="empty">${
      state.showsPlaintext === false
        ? 'Prompt text is hidden on this console (DLP_DASHBOARD_PLAINTEXT).'
        : 'Nothing sensitive found yet.'
    }</div>`;
    return;
  }

  const mappings = event.mappings ?? [];
  const observed = event.observed === true || event.sanitized == null;
  meta.textContent = `${mappings.length} value${mappings.length === 1 ? '' : 's'} ${
    observed ? 'would be replaced' : 'replaced'
  } · ${time(event.ts)}`;

  el.innerHTML = `
    <div class="grid grid--2" style="gap:10px">
      <div>
        <div class="metric__label">As written${observed ? '' : ' — stayed inside'}</div>
        <pre class="mono" style="white-space:pre-wrap;font-size:12px;margin:6px 0 0;padding:10px;
             background:var(--surface-sunken);border-radius:var(--radius-sm)">${esc(clip(event.original, 620))}</pre>
      </div>
      <div>
        <div class="metric__label">${observed ? 'Forwarded — unchanged, observe mode' : 'Forwarded — left the network'}</div>
        <pre class="mono" style="white-space:pre-wrap;font-size:12px;margin:6px 0 0;padding:10px;
             background:var(--surface-sunken);border-radius:var(--radius-sm);
             ${observed ? 'border:1px dashed var(--border-strong)' : ''}">${esc(
               clip(observed ? event.original : event.sanitized, 620))}</pre>
      </div>
    </div>
    <table class="data data--dense" style="margin-top:10px">
      <thead><tr><th>${observed ? 'Would become' : 'Replacement'}</th><th>Class</th><th>Found by</th>
      <th style="text-align:right">Confidence</th></tr></thead>
      <tbody>${mappings.map((mp) => `<tr>
        <td class="mono">${mp.redacted ? `[REDACTED:${esc(mp.cls)}]` : mp.token ? esc(mp.token) : '<span class="faint">—</span>'}</td>
        <td>${esc(mp.cls ?? '')}</td>
        <td class="muted">${esc(mp.detector ?? '')}${mp.tier ? ` · ${esc(mp.tier)}` : ''}</td>
        <td class="mono" style="text-align:right">${mp.confidence != null ? Number(mp.confidence).toFixed(2) : ''}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ helpers -

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '');

function fmtMs(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  if (n >= 10) return `${n.toFixed(0)}ms`;
  return `${n.toFixed(2)}ms`;
}
