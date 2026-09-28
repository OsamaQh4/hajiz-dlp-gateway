const feedList = document.getElementById('feed-list');
const feedEmpty = document.getElementById('feed-empty');
const detail = document.getElementById('detail');
const tiles = document.getElementById('tiles');
const escalations = document.getElementById('escalations');

const requests = new Map();
let selectedId = null;
let latest = null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

connect();
document.getElementById('verify-btn').addEventListener('click', verifyAudit);

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => setConn('live', 'connected');
  source.onerror = () => setConn('dead', 'reconnecting…');
  source.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    if (payload.kind === 'hello') return hydrate(payload.state);
    handleEvent(payload);
    refreshState();
  };
}

function setConn(cls, text) {
  document.getElementById('conn-dot').className = `dot ${cls}`;
  document.getElementById('conn-text').textContent = text;
}

function hydrate(state) {
  latest = state;
  renderTiles(state);
  renderFooter(state);
  for (const e of state.events || []) handleEvent(e);
}

async function refreshState() {
  try {
    const state = await (await fetch('/api/state')).json();
    latest = state;
    renderTiles(state);
    renderFooter(state);
  } catch {
    /* the SSE reconnect will catch us up */
  }
}

function handleEvent(event) {
  if (event.kind === 'request') {
    requests.set(event.requestId, event);
    addFeedRow(event);
    if (!selectedId) select(event.requestId);
  } else if (event.kind === 'escalation_pending') {
    renderEscalation(event);
  } else if (event.kind === 'escalation_resolved') {
    document.getElementById(`esc-${event.requestId}`)?.remove();
  }
}

function addFeedRow(event) {
  feedEmpty.style.display = 'none';
  const li = document.createElement('li');
  li.id = `row-${event.requestId}`;
  li.innerHTML = `
    <div class="row">
      <span class="pill ${esc(event.action)}">${esc(event.action)}</span>
      <span class="time">${new Date(event.ts).toLocaleTimeString()}</span>
    </div>
    <div class="summary">
      ${event.findings} finding${event.findings === 1 ? '' : 's'}
      · ${esc(Object.keys(event.byClass || {}).join(', ') || 'clean')}
      · ${fmt(event.totalMs)} ms
    </div>`;
  li.addEventListener('click', () => select(event.requestId));
  feedList.prepend(li);
  while (feedList.children.length > 80) feedList.lastChild.remove();
}

function select(id) {
  selectedId = id;
  for (const li of feedList.children) li.classList.toggle('selected', li.id === `row-${id}`);
  renderDetail(requests.get(id));
}

function renderDetail(event) {
  if (!event) return;
  const leaks = (event.mappings || []).filter((m) => m.original);
  const hasPlaintext = event.original != null;

  detail.innerHTML = `
    <h2>Request ${esc(event.requestId.slice(0, 8))}</h2>
    <div class="meta">
      <span>decision <b class="pill ${esc(event.action)}">${esc(event.action)}</b></span>
      <span>session <b>${esc(event.sessionId)}</b></span>
      <span>route <b>${esc(event.route)}</b></span>
      <span>tier A <b>${fmt(event.tierAMs)} ms</b></span>
      <span>tier B <b>${event.tierBRan ? `${fmt(event.tierBMs)} ms` : 'not needed'}</b></span>
      <span>gateway <b>${fmt(event.totalMs)} ms</b></span>
      ${event.reviewMs ? `<span>human review <b>${(event.reviewMs / 1000).toFixed(1)} s</b></span>` : ''}
      ${event.judgeModel ? `<span>judge <b>${esc(event.judgeModel)}</b></span>` : ''}
    </div>
    ${event.reasons?.length ? `<div class="notice">${event.reasons.map(esc).join(' · ')}</div>` : ''}
    ${
      event.judgeDegraded
        ? `<div class="notice">Semantic judge unavailable — this decision used Tier A signals and degraded cues only.${
            event.judgeError ? `<br><span class="mono">${esc(event.judgeError)}</span>` : ''
          }</div>`
        : ''
    }
    ${!event.tierBRan && event.skipReason ? `<div class="notice">Tier B skipped: ${esc(event.skipReason)}</div>` : ''}

    <div class="split">
      <div class="pane">
        <h3>What the employee typed</h3>
        <pre>${hasPlaintext ? highlightLeaks(event.original, leaks) : '<span class="placeholder">hidden — dashboard plaintext is disabled</span>'}</pre>
      </div>
      <div class="pane">
        <h3>What actually left the network</h3>
        <pre>${
          event.action === 'block'
            ? '<span class="placeholder">nothing — the request was blocked</span>'
            : hasPlaintext
              ? highlightTokens(event.sanitized)
              : '<span class="placeholder">hidden — dashboard plaintext is disabled</span>'
        }</pre>
      </div>
    </div>

    ${
      event.mappings?.length
        ? `<table>
            <thead><tr><th>placeholder</th><th>class</th><th>detected by</th><th>tier</th><th>confidence</th><th>why</th></tr></thead>
            <tbody>
              ${event.mappings
                .map(
                  (m) => `<tr>
                    <td class="mono">${esc(m.token)}</td>
                    <td>${esc(m.cls)}</td>
                    <td class="mono">${esc(m.detector)}</td>
                    <td class="${m.tier === 'A' ? 'tierA' : 'tierB'}">${esc(m.tier)}</td>
                    <td class="mono">${(m.confidence ?? 0).toFixed(2)}</td>
                    <td>${esc(m.rationale || '')}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
        : '<p class="empty">No sensitive spans in this request.</p>'
    }`;
}

function highlightLeaks(text, mappings) {
  let html = esc(text);
  const seen = new Set();
  for (const m of [...mappings].sort((a, b) => (b.original?.length || 0) - (a.original?.length || 0))) {
    if (!m.original || seen.has(m.original)) continue;
    seen.add(m.original);
    html = html.replace(new RegExp(escapeRe(esc(m.original)), 'g'), (hit) => `<mark class="leak">${hit}</mark>`);
  }
  return html;
}

function highlightTokens(text) {
  return esc(text).replace(/\b[A-Z]+_\d+\b/g, (t) => `<mark class="token">${t}</mark>`);
}

function renderEscalation(event) {
  const div = document.createElement('div');
  div.className = 'banner';
  div.id = `esc-${event.requestId}`;
  div.innerHTML = `
    <h3>Human review requested — session ${esc(event.sessionId)}</h3>
    <div class="why">
      ${event.findings
        .map((f) => `<span class="mono">${esc(f.cls)}</span> (${(f.confidence ?? 0).toFixed(2)}) — ${esc(f.rationale || f.preview || '')}`)
        .join('<br>')}
    </div>
    <button class="approve" data-approve="1">Approve and send (pseudonymized)</button>
    <button class="deny">Decline</button>`;
  div.querySelector('.approve').addEventListener('click', () => resolve(event.requestId, true));
  div.querySelector('.deny').addEventListener('click', () => resolve(event.requestId, false));
  escalations.prepend(div);
}

async function resolve(requestId, approved) {
  await fetch(`/api/escalations/${requestId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved, reviewer: 'security-analyst' }),
  });
  document.getElementById(`esc-${requestId}`)?.remove();
}

function renderTiles(state) {
  const m = state.metrics;
  const tile = (label, value, sub = '', cls = '') =>
    `<div class="tile ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  tiles.innerHTML = [
    tile('Requests', m.requests, 'through the gateway'),
    tile('Pseudonymized', m.byAction.pseudonymize, 'sent, but sanitized', 'ok'),
    tile('Escalated', m.byAction.escalate, 'a human was asked', 'warn'),
    tile('Blocked', m.byAction.block, 'never left the network', 'bad'),
    tile('Tier B rate', `${Math.round(m.tierBRate * 100)}%`, 'of prompts needed the judge'),
    tile('Tier A p50', m.tierA.p50 == null ? '—' : `${m.tierA.p50}`, 'ms, deterministic layer'),
    tile('Tier A p95', m.tierA.p95 == null ? '—' : `${m.tierA.p95}`, 'ms'),
    tile('Tier B p95', m.tierB.p95 == null ? '—' : `${m.tierB.p95}`, 'ms, judge only'),
    tile('Gateway p95', m.total.p95 == null ? '—' : `${m.total.p95}`, 'ms, human review excluded'),
  ].join('');
}

function renderFooter(state) {
  document.getElementById('footer-policy').textContent =
    `policy: ${state.policy.name} v${state.policy.version}${state.policy.error ? ` (error: ${state.policy.error})` : ''}`;
  const judge = document.getElementById('footer-judge');
  judge.textContent =
    `judge: ${state.judge.provider}:${state.judge.model} @ ${state.judge.residency} (${state.judge.host})` +
    (state.judge.standIn ? ' · STAND-IN for an on-prem model' : '');
  judge.style.color = state.judge.standIn ? 'var(--warn)' : '';
  document.getElementById('footer-mode').textContent =
    `upstream: ${state.mode}${state.showsPlaintext ? ' · dashboard plaintext ON (demo only)' : ''}`;
}

async function verifyAudit() {
  const out = document.getElementById('verify-result');
  out.textContent = 'checking…';
  const r = await (await fetch('/api/audit/verify')).json();
  out.textContent = r.ok
    ? `chain intact over ${r.records} records`
    : `TAMPERED — chain breaks at record ${r.brokenAt}`;
  out.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : '—');
