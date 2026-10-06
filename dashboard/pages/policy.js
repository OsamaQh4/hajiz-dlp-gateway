/*
 * Policy — the control surface, on one page.
 *
 * Every change here rewrites policy.yaml on the appliance and takes effect on
 * the next prompt. So each one is sent on its own, reported on its own, and
 * refused on its own: there is no draft state to lose and no "save" that
 * applies six things at once, because an administrator who mistypes one of six
 * wants the other five to have happened.
 */

const ACTIONS = ['allow', 'pseudonymize', 'redact', 'escalate', 'block'];

const ACTION_HELP = {
  allow: 'Goes through unchanged.',
  pseudonymize: 'Placeholder out, the original back in the reply.',
  redact: 'Removed for good. Never comes back.',
  escalate: 'Held until a person approves it.',
  block: 'The whole request is refused.',
};

// Which tier finds each class, so the table can say where a rule is enforced.
const FOUND_BY = {
  national_id: 'Tier 1 · checksum',
  iban: 'Tier 1 · checksum',
  card: 'Tier 1 · checksum',
  email: 'Tier 1 · pattern',
  phone: 'Tier 1 · pattern',
  internal_host: 'Tier 1 · pattern',
  credentials: 'Tier 1 · pattern',
  secret: 'Tier 1 · entropy',
  person: 'Tier 2 · judge',
  org: 'Tier 2 · judge',
  project: 'Tier 1 watchlist · Tier 2 judge',
  financial: 'Tier 2 · judge',
  source_code: 'Tier 2 · judge',
  location: 'Tier 2 · judge',
  health: 'Tier 2 · judge',
  legal: 'Tier 2 · judge',
  strategic: 'Tier 2 · judge',
  vulnerability: 'Tier 2 · judge',
  other: 'Tier 2 · judge',
};

export function renderPolicy(mount, { store }) {
  mount.innerHTML = `
    <p class="eyebrow">Policy · <span class="mono" id="po-path"></span></p>
    <h1 class="display">What each kind of data is allowed to do.</h1>
    <p class="lede">One action per class. When a prompt carries several, the strictest one wins.
    Changes are written to the file on this appliance and apply to the next prompt.</p>
    <div id="po-status"></div>
    <div id="po-flash"></div>

    <h2 class="section">Data classes</h2>
    <div class="card" id="po-classes"></div>

    <div class="grid grid--2" style="margin-top:14px">
      <div class="card"><h2 class="section" style="margin:0 0 10px">Detection gate</h2><div id="po-gate"></div></div>
      <div class="card"><h2 class="section" style="margin:0 0 10px">Escalation</h2><div id="po-escalation"></div></div>
    </div>

    <h2 class="section">Organization watchlist</h2>
    <div class="card" id="po-watchlist"></div>

    <h2 class="section">Change history</h2>
    <div class="card" style="padding:18px 8px" id="po-versions"></div>`;

  let policy = null;
  let status = null;
  let busy = false;

  const flash = (kind, message) => {
    mount.querySelector('#po-flash').innerHTML =
      `<div class="banner banner--${kind}" style="margin-top:14px">${esc(message)}</div>`;
    if (kind === 'info') setTimeout(() => { mount.querySelector('#po-flash').innerHTML = ''; }, 4000);
  };

  const pull = async () => {
    const [p, v] = await Promise.all([
      fetch('/api/policy').then((r) => r.json()).catch(() => null),
      fetch('/api/policy/versions').then((r) => r.json()).catch(() => ({ versions: [] })),
    ]);
    if (!p) return;
    policy = p.policy;
    status = p.status;
    paint(v.versions ?? []);
  };

  /** One edit, sent on its own, with the outcome reported in place. */
  const send = async (edits, summary) => {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch('/api/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits, summary }),
      });
      const out = await res.json();
      if (out.ok) flash('info', `Saved and applied. ${summary}`);
      else flash('warn', `Refused, nothing changed. ${(out.problems ?? []).join('; ')}`);
    } catch (err) {
      flash('warn', `Could not reach the gateway: ${err.message}`);
    } finally {
      busy = false;
      await pull();
    }
  };

  const rollback = async (seq) => {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch('/api/policy/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq }),
      });
      const out = await res.json();
      flash(out.ok ? 'info' : 'warn', out.ok ? `Rolled back to v${seq}.` : (out.problems ?? []).join('; '));
    } finally {
      busy = false;
      await pull();
    }
  };

  function paint(versions) {
    mount.querySelector('#po-path').textContent = status?.path ?? '';
    paintStatus(mount.querySelector('#po-status'), status);
    paintClasses(mount.querySelector('#po-classes'), policy, send);
    paintGate(mount.querySelector('#po-gate'), policy, send);
    paintEscalation(mount.querySelector('#po-escalation'), policy, send);
    paintWatchlist(mount.querySelector('#po-watchlist'), policy, send);
    paintVersions(mount.querySelector('#po-versions'), versions, rollback);
  }

  pull();
  const unsubscribe = store.subscribe(() => {});
  return { stop: unsubscribe };
}

function paintStatus(el, status) {
  if (!status) {
    el.innerHTML = '';
    return;
  }
  if (status.stale) {
    // The gateway is enforcing something other than what the file says. This is
    // the one policy state that must never be quiet.
    el.innerHTML = `<div class="banner banner--warn" style="margin-top:16px">
      <span class="dot dot--off" style="margin-top:5px"></span>
      <span><strong>The file on disk was rejected and is not running.</strong>
      ${esc(status.error ?? '')} The gateway is still enforcing the last policy that loaded cleanly —
      fix the file, or roll back to a stored version below.</span></div>`;
    return;
  }
  el.innerHTML = `<div class="banner banner--info" style="margin-top:16px">
    <span><strong>${esc(status.name ?? 'policy')}</strong> · version ${esc(String(status.version ?? '?'))},
    loaded ${status.loadedAt ? new Date(status.loadedAt).toLocaleTimeString([], { hour12: false }) : '—'}.
    Hot reload is on; no restart is needed.</span></div>`;
}

function paintClasses(el, policy, send) {
  const actions = policy?.actions ?? {};
  const classes = Object.keys(actions);
  if (!classes.length) {
    el.innerHTML = `<div class="empty">The policy defines no classes.</div>`;
    return;
  }

  const legend = ACTIONS.map(
    (a) => `<div><span class="pill pill--${a}">${a}</span>
      <div class="stat__note" style="margin-top:4px">${esc(ACTION_HELP[a])}</div></div>`,
  ).join('');

  const rows = classes.map((cls) => {
    const chosen = actions[cls];
    const choices = ACTIONS.map((a) => `
      <button class="btn" data-cls="${esc(cls)}" data-action="${a}"
        style="height:26px;padding:0 9px;font-size:12px;${
          a === chosen
            ? `background:var(--${a}-weak);color:var(--${a});border-color:var(--${a});font-weight:700`
            : 'border-color:transparent;background:transparent;color:var(--text-muted)'
        }">${a}</button>`).join('');
    return `<tr>
      <td><strong>${esc(cls)}</strong></td>
      <td class="muted">${esc(FOUND_BY[cls] ?? '')}</td>
      <td style="text-align:right"><div style="display:inline-flex;gap:2px">${choices}</div></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:16px">${legend}</div>
    <table class="data"><tbody>${rows}</tbody></table>`;

  for (const btn of el.querySelectorAll('[data-cls]')) {
    btn.addEventListener('click', () => {
      const { cls, action } = btn.dataset;
      if (actions[cls] === action) return;
      send([{ path: ['actions', cls], value: action }], `${cls} → ${action}`);
    });
  }
}

function paintGate(el, policy, send) {
  const gate = policy?.thresholds?.sentence_hot_above ?? 0.5;
  el.innerHTML = `
    <div class="mono" style="font-size:30px" id="po-gate-value">${Number(gate).toFixed(2)}</div>
    <input type="range" min="0.05" max="0.95" step="0.05" value="${gate}" id="po-gate-range"
           style="width:100%;margin:10px 0 4px" />
    <p class="stat__note" style="margin:0">A judge score at or above this counts as a finding, and the
    class action applies. Swept on this corpus rather than guessed: 0.50 caught everything the benchmark
    contains and is the lowest setting whose numbers repeated across runs. Raising it toward 0.80 trades
    recall for silence.</p>`;

  const range = el.querySelector('#po-gate-range');
  const value = el.querySelector('#po-gate-value');
  range.addEventListener('input', () => { value.textContent = Number(range.value).toFixed(2); });
  range.addEventListener('change', () =>
    send([{ path: ['thresholds', 'sentence_hot_above'], value: Number(range.value) }],
      `detection gate → ${Number(range.value).toFixed(2)}`));
}

function paintEscalation(el, policy, send) {
  const esc_ = policy?.escalation ?? {};
  const waitS = Math.round((esc_.wait_for_human_ms ?? 90000) / 1000);
  const limit = esc_.auto_decisions_before_block ?? 3;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0">
      <div><strong>Wait for a person</strong>
        <div class="stat__note">How long a held prompt waits before the appliance decides on its own.</div></div>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="number" min="5" max="600" step="5" value="${waitS}" id="po-wait"
               style="width:76px;height:30px;text-align:right;font-family:var(--font-mono);
                      border:1px solid var(--border-strong);border-radius:var(--radius-sm);
                      background:var(--surface-raised);color:var(--text)" />
        <span class="muted">s</span>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;
                border-top:1px solid var(--border)">
      <div><strong>Machine decisions in a row</strong>
        <div class="stat__note">After this many consecutive timeouts decided without a person, every later
        timeout is refused until someone answers one.</div></div>
      <input type="number" min="1" max="20" value="${limit}" id="po-ratchet"
             style="width:62px;height:30px;text-align:right;font-family:var(--font-mono);
                    border:1px solid var(--border-strong);border-radius:var(--radius-sm);
                    background:var(--surface-raised);color:var(--text)" />
    </div>`;

  el.querySelector('#po-wait').addEventListener('change', (e) => {
    const s = Math.max(5, Number(e.target.value) || 90);
    send([{ path: ['escalation', 'wait_for_human_ms'], value: s * 1000 }], `wait for a person → ${s}s`);
  });
  el.querySelector('#po-ratchet').addEventListener('change', (e) => {
    const n = Math.max(1, Number(e.target.value) || 3);
    send([{ path: ['escalation', 'auto_decisions_before_block'], value: n }], `machine decisions in a row → ${n}`);
  });
}

function paintWatchlist(el, policy, send) {
  const terms = policy?.watchlist ?? [];
  const chips = terms.map((t, i) => `
    <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:99px;
                 background:var(--surface-sunken);border:1px solid var(--border);font-size:13px">
      <span class="mono">${esc(t)}</span>
      <button class="btn btn--ghost" data-remove="${i}" style="height:18px;padding:0 4px;font-size:14px;
              line-height:1">×</button></span>`).join(' ');

  el.innerHTML = `
    <p class="stat__note" style="margin:0 0 12px">Terms only this organization knows are sensitive. Matched
    deterministically in Tier 1, before anything reaches a model — which is how codenames no vendor has ever
    seen get caught. Written in Arabic as well as English, since employees write in both.</p>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${chips || '<span class="faint">No terms.</span>'}</div>
    <div style="display:flex;gap:8px">
      <input id="po-wl-input" placeholder="Add a codename or project name"
             style="flex:1;height:32px;padding:0 10px;border:1px solid var(--border-strong);
                    border-radius:var(--radius-sm);background:var(--surface-raised);color:var(--text);font:inherit" />
      <button class="btn" id="po-wl-add">Add</button>
    </div>`;

  const input = el.querySelector('#po-wl-input');
  const add = () => {
    const term = input.value.trim();
    if (!term || terms.includes(term)) return;
    send([{ path: ['watchlist'], list: [...terms, term] }], `watchlist + ${term}`);
  };
  el.querySelector('#po-wl-add').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  for (const btn of el.querySelectorAll('[data-remove]')) {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.remove);
      send([{ path: ['watchlist'], list: terms.filter((_, n) => n !== i) }], `watchlist − ${terms[i]}`);
    });
  }
}

function paintVersions(el, versions, rollback) {
  if (!versions.length) {
    el.innerHTML = `<div class="empty">No changes have been made from this console yet.</div>`;
    return;
  }

  const rows = versions.map((v) => `
    <tr>
      <td class="mono">v${v.seq}</td>
      <td class="mono faint">${new Date(v.at).toLocaleString([], { hour12: false })}</td>
      <td>${v.accepted
        ? `<span class="pill pill--allow">applied</span>`
        : `<span class="pill pill--block">rejected</span>`}</td>
      <td>${esc(v.summary || (v.problems ?? []).join('; '))}</td>
      <td style="text-align:right">${v.accepted
        ? `<button class="btn" data-rollback="${v.seq}" style="height:26px;font-size:12px">Roll back to this</button>`
        : '<span class="faint">never ran</span>'}</td>
    </tr>`).join('');

  el.innerHTML = `
    <p class="stat__note" style="padding:0 10px 10px">Each entry is the whole file as it stood before that
    change. A rejected edit is kept too — that an edit was tried and refused is worth knowing.</p>
    <table class="data"><thead><tr><th>Version</th><th>When</th><th>Outcome</th><th>Change</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  for (const btn of el.querySelectorAll('[data-rollback]')) {
    btn.addEventListener('click', () => rollback(Number(btn.dataset.rollback)));
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
