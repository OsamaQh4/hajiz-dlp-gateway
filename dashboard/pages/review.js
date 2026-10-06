/*
 * Review queue — a person deciding about one prompt, with a clock running.
 *
 * Everything on this page is time-sensitive in a way the rest of the console
 * is not: the prompt is held open on a live HTTP connection and an employee is
 * waiting at the other end of it. So the countdown ticks locally between polls
 * rather than only moving when the server answers, and the consequence of
 * doing nothing is written out in full rather than implied by a timer.
 */

export function renderReview(mount, { store }) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead" id="rv-headline">Review queue</h1>
      <span class="toolbar__sub" id="rv-lede">Nothing is waiting</span>
      <span class="pagehead__spacer"></span>
      <span class="toolbar__sub">Approve sends the prompt as written · refuse stops it and notifies the sender</span>
    </div>
    <div id="rv-ratchet"></div>
    <div id="rv-body" style="margin-top:12px"></div>`;

  let data = { items: [], limit: 3, onTimeout: 'judge' };
  let selected = null;
  let busy = false;

  /*
   * Repaint only when something actually changed.
   *
   * The first cut rebuilt the page on every poll, two seconds apart. That
   * destroys and recreates the buttons underneath whoever is reading the
   * prompt: a click landing in the same tick is thrown away, focus is lost and
   * the scroll position resets. On the one page where a person is deliberating
   * with a clock running, the console must not move under them. The countdown
   * updates on its own below and needs no repaint.
   */
  const signature = (d) =>
    JSON.stringify([
      d.limit,
      (d.items ?? []).map((i) => [i.requestId, i.expiresAt, i.consecutive, (i.findings ?? []).length]),
    ]);

  let painted = null;

  const pull = async () => {
    try {
      const res = await fetch('/api/escalations');
      if (!res.ok) return;
      const next = await res.json();
      const sig = signature(next) + (busy ? '|busy' : '');
      data = next;
      if (!data.items.some((i) => i.requestId === selected)) selected = data.items[0]?.requestId ?? null;
      if (sig === painted) return;
      painted = sig;
      paint();
    } catch {
      /* the shell already shows the connection as down */
    }
  };

  const decide = async (requestId, approved) => {
    if (busy) return;
    busy = true;
    painted = null;
    paint();
    try {
      await fetch(`/api/escalations/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved, reviewer: 'console' }),
      });
    } finally {
      busy = false;
      await pull();
    }
  };

  function paint() {
    const items = data.items ?? [];
    mount.querySelector('#rv-headline').textContent = items.length ? `${items.length} held` : 'Held for review';
    mount.querySelector('#rv-lede').textContent = items.length
      ? 'soonest timeout first'
      : 'nothing is waiting';

    paintRatchet(mount.querySelector('#rv-ratchet'), items, data);

    const body = mount.querySelector('#rv-body');
    if (!items.length) {
      body.innerHTML = `<div class="panel"><div class="emptyState">
        <div class="orb" style="--orb-a:#b06c14;--orb-b:#d99b3f"></div>
        <div class="emptyState__body">
          <p class="emptyState__title">Nothing is waiting</p>
          <p class="emptyState__text">When policy sends a prompt to a person, it appears here with a
          countdown. Prompts time out whether or not anyone is looking.</p>
        </div></div></div>`;
      return;
    }

    const current = items.find((i) => i.requestId === selected) ?? items[0];
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start">
        <div>${caseCard(current, busy)}</div>
        <div>${queueList(items, current.requestId)}</div>
      </div>`;

    for (const el of body.querySelectorAll('[data-select]')) {
      el.addEventListener('click', () => {
        selected = el.dataset.select;
        painted = null;
        paint();
      });
    }
    const approve = body.querySelector('[data-approve]');
    const refuse = body.querySelector('[data-refuse]');
    approve?.addEventListener('click', () => decide(current.requestId, true));
    refuse?.addEventListener('click', () => decide(current.requestId, false));
  }

  // One tick a second keeps the countdown honest between polls; the poll keeps
  // the queue honest between ticks.
  const tick = setInterval(() => {
    for (const el of mount.querySelectorAll('[data-expires]')) {
      const left = Number(el.dataset.expires) - Date.now();
      el.textContent = countdown(left);
      el.classList.toggle('faint', left <= 0);
    }
  }, 1000);

  const poll = setInterval(pull, 2000);
  const unsubscribe = store.subscribe(() => pull());
  pull();

  return {
    stop() {
      clearInterval(tick);
      clearInterval(poll);
      unsubscribe();
    },
  };
}

function paintRatchet(el, items, data) {
  const limit = data.limit ?? 3;
  const consecutive = items.reduce((max, i) => Math.max(max, i.consecutive ?? 0), 0);
  if (!items.length && !consecutive) {
    el.innerHTML = '';
    return;
  }

  const pips = Array.from({ length: limit }, (_, i) => {
    const used = i < consecutive;
    return `<span style="width:26px;height:6px;border-radius:99px;background:${
      used ? 'var(--escalate)' : 'var(--border-strong)'
    }"></span>`;
  }).join('');

  const atLimit = consecutive >= limit;
  el.innerHTML = `
    <div class="banner ${atLimit ? 'banner--warn' : 'banner--info'}" style="margin-top:18px">
      <span style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="font-family:var(--font-mono)">${consecutive} of ${limit}</strong>
        <span style="display:flex;gap:3px">${pips}</span>
        <span>decided without a person, in a row.
        ${
          atLimit
            ? `The limit is reached: every later timeout is refused whatever the judge says, until a person answers one.`
            : `The limit is ${limit}. Answering any held prompt resets the count to zero.`
        }</span>
      </span>
    </div>`;
}

function caseCard(item, busy) {
  const findings = item.findings ?? [];
  const top = findings[0];
  const left = (item.expiresAt ?? 0) - Date.now();

  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap">
        <div>
          <span class="mono faint">${esc(item.requestId.slice(0, 8))}</span>
          <span class="muted"> · held ${timeOf(item.heldAt)}</span>
        </div>
        <div class="mono" style="font-size:22px" data-expires="${item.expiresAt ?? 0}">${countdown(left)}</div>
      </div>

      <h2 class="section" style="margin:10px 0 2px">${esc(top?.cls ?? 'Held for review')}</h2>
      <p class="stat__note" style="margin:0 0 14px">
        ${esc((item.reasons ?? []).join(' · ') || 'Policy sends this class to a person.')}
      </p>

      ${
        item.prompt
          ? `<div class="card card--flat">
               <div class="stat__label">The prompt, exactly as written <span class="faint">— not sent</span></div>
               <pre class="mono" style="white-space:pre-wrap;font-size:12.5px;margin:8px 0 0">${esc(clip(item.prompt, 1400))}</pre>
             </div>`
          : `<div class="notBuilt">Prompt text is not shown on this console. A reviewer deciding without
             seeing the text is deciding on the class alone — turn on DLP_DASHBOARD_PLAINTEXT to show it.</div>`
      }

      ${findings.length ? findingTable(findings) : ''}

      <div style="display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap">
        <button class="btn btn--primary" data-approve ${busy ? 'disabled' : ''}>Approve and send</button>
        <button class="btn" data-refuse ${busy ? 'disabled' : ''}>Refuse</button>
        <span class="stat__note" style="margin:0">Either answer resets the unattended count to zero.</span>
      </div>

      <div class="grid grid--2" style="margin-top:16px">
        <div class="card card--flat">
          <div class="stat__label">Where it came from</div>
          <div class="mono" style="margin-top:4px">${esc(item.sessionId ?? 'anon')}</div>
          <div class="stat__note">Group ${esc(item.group ?? 'none')}. No name is shown: the appliance sees a
          session, not a person. Names appear once an identity source is connected on
          <a href="/integrations" style="color:var(--accent);font-weight:600">Integrations</a>.</div>
        </div>
        <div class="card card--flat">
          <div class="stat__label">If nobody answers</div>
          <div class="stat__note" style="margin-top:4px">
            The appliance decides on its own, and that counts toward the limit above. Past the limit every
            later timeout is refused regardless of the verdict, until a person answers one.
          </div>
        </div>
      </div>
    </div>`;
}

function findingTable(findings) {
  const rows = findings.map((f) => `
    <tr>
      <td>${esc(f.cls ?? '')}</td>
      <td class="muted">${esc(f.detector ?? '')}${f.tier ? ` · tier ${esc(f.tier)}` : ''}</td>
      <td class="mono">${f.preview ? esc(clip(f.preview, 90)) : '<span class="faint">hidden</span>'}</td>
      <td class="mono" style="text-align:right">${f.confidence != null ? Number(f.confidence).toFixed(2) : ''}</td>
    </tr>`).join('');

  return `<table class="data" style="margin-top:16px">
    <thead><tr><th>Class</th><th>Found by</th><th>Passage</th>
    <th style="text-align:right">Confidence</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function queueList(items, currentId) {
  const rows = items.map((i) => {
    const active = i.requestId === currentId;
    const cls = (i.findings ?? [])[0]?.cls ?? 'held';
    return `
      <div data-select="${esc(i.requestId)}"
           style="padding:11px 12px;border-radius:var(--radius-sm);cursor:pointer;margin-bottom:6px;
                  background:${active ? 'var(--accent-weak)' : 'transparent'};
                  border:1px solid ${active ? 'var(--accent)' : 'var(--border)'}">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <strong style="font-size:13px">${esc(cls)}</strong>
          <span class="mono" style="font-size:12.5px" data-expires="${i.expiresAt ?? 0}">
            ${countdown((i.expiresAt ?? 0) - Date.now())}</span>
        </div>
        <div class="stat__note" style="margin:2px 0 0">${esc(i.sessionId ?? 'anon')} · ${esc(i.group ?? 'no group')}</div>
      </div>`;
  }).join('');

  return `<div class="card" style="padding:14px">
    <div class="stat__label" style="margin-bottom:8px">Waiting · soonest first</div>${rows}</div>`;
}

// ------------------------------------------------------------------ helpers -

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : 'just now');

function countdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'deciding…';
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
