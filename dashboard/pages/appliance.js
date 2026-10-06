/*
 * Appliance — the things that make this trustworthy infrastructure rather than
 * an application: who can sign in, what certificate it presents, which ports
 * it listens on, and what it would take to undo a policy change.
 *
 * The page states its own weaknesses. A console that reports "TLS: not
 * configured" as a neutral row is reporting a finding as a setting, and the
 * person reading it is the only one who can fix it.
 */

export function renderAppliance(mount) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">Appliance</h1>
      <span class="toolbar__sub" id="ap-build"></span>
      <span class="pagehead__spacer"></span>
    </div>
    <div id="ap-flash"></div>
    <div id="ap-warnings"></div>

    <div class="split">
      <div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Administrator</span></div>
          <div class="panel__body panel__body--flush" id="ap-account"></div>
        </div>

        <div class="panel">
          <div class="panel__head"><span class="panel__title">Change Password</span></div>
          <div class="panel__body" id="ap-password"></div>
        </div>

        <div class="panel">
          <div class="panel__head"><span class="panel__title">Policy Versions</span>
            <span class="panel__spacer"></span>
            <span class="panel__title" id="ap-vercount" style="font-weight:400;color:var(--text-muted)"></span>
          </div>
          <div class="panel__body panel__body--flush" id="ap-versions"></div>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Console Certificate</span></div>
          <div class="panel__body panel__body--flush" id="ap-tls"></div>
        </div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Listeners</span></div>
          <div class="panel__body panel__body--flush" id="ap-listeners"></div>
        </div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Files</span></div>
          <div class="panel__body panel__body--flush" id="ap-files"></div>
        </div>
        <div class="panel">
          <div class="panel__head"><span class="panel__title">Sessions</span></div>
          <div class="panel__body panel__body--flush" id="ap-sessions"></div>
        </div>
      </div>
    </div>`;

  let state = null;
  let busy = false;

  const flash = (kind, text) => {
    mount.querySelector('#ap-flash').innerHTML =
      `<div class="banner banner--${kind} banner--slim">${esc(text)}</div>`;
    if (kind === 'info') setTimeout(() => { mount.querySelector('#ap-flash').innerHTML = ''; }, 5000);
  };

  const load = async () => {
    try {
      state = await fetch('/api/appliance').then((r) => r.json());
      paint();
    } catch (err) {
      flash('warn', `Could not read the appliance state: ${err.message}`);
    }
  };

  function paint() {
    if (!state) return;
    const b = state.build ?? {};
    mount.querySelector('#ap-build').textContent =
      [b.version && `v${b.version}`, b.commit, b.node].filter(Boolean).join(' · ');

    paintWarnings(mount.querySelector('#ap-warnings'), state);
    paintAccount(mount.querySelector('#ap-account'), state, { unlock, busy });
    paintPassword(mount.querySelector('#ap-password'), { change, busy });
    paintTls(mount.querySelector('#ap-tls'), state.tls ?? {});
    paintListeners(mount.querySelector('#ap-listeners'), state.listeners ?? {});
    paintFiles(mount.querySelector('#ap-files'), state);
    paintSessions(mount.querySelector('#ap-sessions'), state, { revoke, busy });
    paintVersions(mount.querySelector('#ap-versions'), state);
    mount.querySelector('#ap-vercount').textContent = `${state.policy?.storedVersions ?? 0} stored`;
  }

  async function change(current, next) {
    if (busy) return;
    busy = true;
    paint();
    try {
      const res = await fetch('/api/appliance/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      const body = await res.json();
      flash(body.ok ? 'info' : 'warn', body.ok ? 'Password changed.' : body.error ?? 'That did not work.');
    } finally {
      busy = false;
      await load();
    }
  }

  async function unlock() {
    await fetch('/api/appliance/unlock', { method: 'POST' });
    flash('info', 'Lockout cleared.');
    await load();
  }

  async function revoke() {
    // This signs the caller out too, by design, so say so before doing it.
    if (!window.confirm('This ends every console session, including this one. Continue?')) return;
    await fetch('/api/appliance/revoke-sessions', { method: 'POST' });
    window.location.reload();
  }

  load();
  return null;
}

function paintWarnings(el, state) {
  const warnings = [];
  if (state.tls?.enabled === false) warnings.push(state.tls.note);
  if (state.listeners?.shared) warnings.push(state.listeners.note);
  if (state.tls?.error) warnings.push(`The configured certificate could not be read: ${state.tls.error}`);
  if (state.tls?.enabled && state.tls.expiresInDays != null && state.tls.expiresInDays < 30) {
    warnings.push(`The console certificate expires in ${state.tls.expiresInDays} days.`);
  }

  el.innerHTML = warnings
    .map((w) => `<div class="banner banner--warn banner--slim">
      <span class="dot dot--warn" style="margin-top:4px"></span><span>${esc(w)}</span></div>`)
    .join('');
}

function paintAccount(el, state, { unlock, busy }) {
  const a = state.account ?? {};
  if (!a.provisioned) {
    el.innerHTML = `<div class="row"><div class="row__label">No administrator exists.</div></div>`;
    return;
  }

  el.innerHTML = `
    ${row('Username', a.username)}
    ${row('Created', date(a.createdAt))}
    ${row('Password last set', date(a.passwordChangedAt))}
    ${row('Last sign-in', a.lastSignInAt ? date(a.lastSignInAt) : 'never')}
    <div class="row">
      <div class="row__label"><strong>Failed attempts</strong>
        <div class="row__help">The account locks for ${Math.round((a.lockoutMs ?? 0) / 60000)} minutes after
        ${a.maxAttempts} failures in that window. The count expires on its own, so nobody can hold you out
        by guessing forever.</div></div>
      <span class="mono">${a.failedAttempts} / ${a.maxAttempts}</span>
    </div>
    ${a.locked ? `<div class="row">
      <div class="row__label"><strong style="color:var(--block)">Locked</strong>
        <div class="row__help">Until ${esc(date(a.lockedUntil))}</div></div>
      <button class="btn btn--sm" id="ap-unlock" ${busy ? 'disabled' : ''}>Clear lockout</button>
    </div>` : ''}`;

  el.querySelector('#ap-unlock')?.addEventListener('click', unlock);
}

function paintPassword(el, { change, busy }) {
  el.innerHTML = `
    <label class="auth__label" for="ap-cur">Current password</label>
    <input class="auth__input" id="ap-cur" type="password" autocomplete="current-password" />
    <label class="auth__label" for="ap-new">New password</label>
    <input class="auth__input" id="ap-new" type="password" autocomplete="new-password" />
    <p class="row__help" style="margin:-8px 0 12px">At least 12 characters. The current password is asked
    for even though you are signed in: a session proves someone signed in once, not that the person at the
    keyboard now is the same one.</p>
    <button class="btn btn--primary btn--sm" id="ap-change" ${busy ? 'disabled' : ''}>Change password</button>`;

  el.querySelector('#ap-change').addEventListener('click', () => {
    change(el.querySelector('#ap-cur').value, el.querySelector('#ap-new').value);
    el.querySelector('#ap-cur').value = '';
    el.querySelector('#ap-new').value = '';
  });
}

function paintTls(el, tls) {
  if (!tls.enabled) {
    el.innerHTML = `
      <div class="row"><div class="row__label"><strong style="color:var(--escalate)">Not configured</strong>
        <div class="row__help">${esc(tls.note ?? '')}</div></div></div>
      <div class="row"><div class="row__label"><strong>To enable</strong>
        <div class="row__help">Set DLP_TLS_CERT and DLP_TLS_KEY to PEM files and restart. The console then
        refuses to start rather than falling back to HTTP, so it cannot end up in the clear by accident.</div>
      </div></div>`;
    return;
  }
  if (tls.error) {
    el.innerHTML = `<div class="row"><div class="row__label">
      <strong style="color:var(--block)">Could not be read</strong>
      <div class="row__help">${esc(tls.error)}</div></div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="row"><div class="row__label"><strong>SHA-256 fingerprint</strong>
      <div class="row__help">${esc(tls.note ?? '')}</div></div></div>
    <div class="row" style="display:block">
      <code class="mono" style="display:block;font-size:11.5px;line-height:1.7;word-break:break-all">${esc(tls.fingerprint ?? '')}</code>
    </div>
    ${row('Subject', tls.subject)}
    ${row('Issuer', tls.issuer)}
    ${row('Expires', `${tls.validTo} (${tls.expiresInDays} days)`)}`;
}

function paintListeners(el, l) {
  el.innerHTML = `
    ${row('Employee traffic', `port ${l.traffic}`)}
    ${row('Console and API', `port ${l.admin}`)}
    <div class="row"><div class="row__label">
      <strong style="color:var(--${l.shared ? 'escalate' : 'allow'})">${l.shared ? 'Shared port' : 'Separated'}</strong>
      <div class="row__help">${esc(l.note ?? '')}</div></div></div>`;
}

function paintFiles(el, state) {
  el.innerHTML = `
    ${row('Policy', state.policy?.path, true)}
    ${row('Audit log', state.audit?.path, true)}
    ${row('Enforcement', state.mode?.enforcement)}
    ${row('Upstream', state.mode?.upstream)}`;
}

function paintSessions(el, state, { revoke, busy }) {
  const hours = Math.round((state.session?.ttlMs ?? 0) / 3600000);
  el.innerHTML = `
    ${row('Session length', `${hours} hours`)}
    <div class="row">
      <div class="row__label"><strong>End all sessions</strong>
        <div class="row__help">Rotates the signing key, so every token ever issued stops working —
        including this one. What you reach for if you believe a session has been taken.</div></div>
      <button class="btn btn--sm" id="ap-revoke" ${busy ? 'disabled' : ''}>Revoke</button>
    </div>`;
  el.querySelector('#ap-revoke').addEventListener('click', revoke);
}

function paintVersions(el, state) {
  const versions = state.policy?.versions ?? [];
  if (!versions.length) {
    el.innerHTML = `<div class="row"><div class="row__help">No policy changes have been made from the
      console yet. Each one stores the file as it was beforehand.</div></div>`;
    return;
  }
  el.innerHTML = versions.map((v) => `
    <div class="row">
      <div class="row__label"><strong>v${v.seq} · ${v.accepted ? 'applied' : 'rejected'}</strong>
        <div class="row__help">${esc(v.summary || (v.problems ?? []).join('; '))}</div></div>
      <span class="mono muted" style="font-size:12px">${esc(date(v.at))}</span>
    </div>`).join('') +
    `<div class="row"><div class="row__help">Roll back from the
      <a href="/policy" style="color:var(--accent)">Policy</a> page.</div></div>`;
}

// ------------------------------------------------------------------ helpers -

const row = (label, value, mono = false) => `
  <div class="row">
    <div class="row__label"><strong>${esc(label)}</strong></div>
    <span class="${mono ? 'mono ' : ''}muted" style="font-size:12.5px;text-align:right;word-break:break-all;max-width:62%">${esc(value ?? '—')}</span>
  </div>`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const date = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { hour12: false });
};
