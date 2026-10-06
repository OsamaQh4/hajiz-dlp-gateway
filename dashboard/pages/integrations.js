/*
 * Integrations — mostly one integration that matters, and two that are honest
 * about not existing.
 *
 * Identity is the one. Without it the console shows addresses everywhere, and
 * with it the same records show people. The page makes that consequence
 * visible before anything is connected, because "put a name to every address"
 * is a change to what this console is, not a setting.
 */

export function renderIntegrations(mount) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">Integrations</h1>
      <span class="toolbar__sub">what this appliance asks other systems</span>
      <span class="pagehead__spacer"></span>
    </div>
    <div id="int-flash"></div>
    <div id="int-body"><div class="empty">Reading…</div></div>`;

  let state = null;
  let busy = false;

  const flash = (kind, text) => {
    mount.querySelector('#int-flash').innerHTML =
      `<div class="banner banner--${kind} banner--slim">${esc(text)}</div>`;
    if (kind === 'info') setTimeout(() => { mount.querySelector('#int-flash').innerHTML = ''; }, 5000);
  };

  const load = async () => {
    try {
      state = await fetch('/api/integrations').then((r) => r.json());
      paint();
    } catch (err) {
      mount.querySelector('#int-body').innerHTML =
        `<div class="banner banner--warn banner--slim">Could not read integrations: ${esc(err.message)}</div>`;
    }
  };

  const save = async (settings, message) => {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch('/api/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const body = await res.json();
      flash(body.ok ? 'info' : 'warn', body.ok ? message : (body.error ?? 'That did not work.'));
    } finally {
      busy = false;
      await load();
    }
  };

  const preview = async (address) => {
    const out = mount.querySelector('#int-preview-out');
    out.innerHTML = '<span class="faint">resolving…</span>';
    try {
      const r = await fetch('/api/identity/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      }).then((x) => x.json());

      out.innerHTML = r.resolved
        ? `<span class="pill pill--allow">resolved</span>
           <strong style="margin-left:8px">${esc(r.person)}</strong>
           <span class="muted"> · ${esc(r.department ?? '—')}</span>
           <span class="faint mono" style="margin-left:8px">via ${esc(r.source)}</span>`
        : `<span class="pill pill--escalate">not resolved</span>
           <span class="muted" style="margin-left:8px">${esc(r.reason ?? '')}</span>
           <div class="row__help" style="margin-top:6px">The console will keep showing
           <span class="mono">${esc(r.address ?? address)}</span>. Nothing is guessed.</div>`;
    } catch (err) {
      out.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    }
  };

  function paint() {
    const id = state.identity ?? {};
    mount.querySelector('#int-body').innerHTML = `
      ${id.enabled ? '' : `<div class="banner banner--info banner--slim">
        <span><strong>No identity source is connected.</strong> This appliance sees a network address and
        nothing else, so Monitor, Review Queue and Audit show addresses rather than people. Connecting a
        source below changes that for records written from then on.</span></div>`}

      <div class="split">
        <div>
          ${panel('Identity Source', `
            <div class="row"><div class="row__help">By itself the appliance knows where a prompt came from
            on the network, not who sent it. An identity source answers one question — who was signed in at
            that address, at that moment — and nothing else is asked of it.</div></div>
            ${beforeAfter()}
            <div class="row">
              <div class="row__label"><strong>Status</strong>
                <div class="row__help">${id.enabled
                  ? `Connected · ${id.source === 'broker' ? 'VDI broker or directory' : 'address list'}`
                  : 'Not connected'}</div></div>
              <button class="btn btn--sm ${id.enabled ? '' : 'btn--primary'}" id="int-toggle" ${busy ? 'disabled' : ''}>
                ${id.enabled ? 'Turn off' : 'Turn on'}</button>
            </div>
            ${id.enabled ? `
              ${row('Addresses in the list', id.entries)}
              ${row('Resolved', `${id.resolved ?? 0} of ${id.lookups ?? 0} lookups`)}
              ${row('Cached now', `${id.cached ?? 0} · ${Math.round((id.ttlMs ?? 0) / 1000)}s each`)}
              ${id.lastError ? row('Last error', id.lastError) : ''}` : ''}`)}

          ${panel('Live Preview', `
            <div class="row"><div class="row__help">Read-only. The appliance asks the source who holds an
            address; it never writes to it.</div></div>
            <div class="row">
              <input class="auth__input" id="int-preview-in" placeholder="10.20.31.47"
                     style="margin:0;flex:1;height:30px" />
              <button class="btn btn--sm" id="int-preview-go">Resolve</button>
            </div>
            <div class="row" style="display:block"><div id="int-preview-out" class="row__help">
              Enter an address this appliance has seen.</div></div>`)}

          ${panel('What Happens If It Stops Answering', `
            <div class="row"><div class="row__label"><strong>Names disappear; nothing else changes</strong>
              <div class="row__help">Inspection, redaction and blocking carry on exactly as before. The
              lookup never reaches the policy decision, so a directory being down cannot change what this
              appliance does to a prompt.</div></div></div>
            <div class="row"><div class="row__label"><strong>Old records keep their addresses</strong>
              <div class="row__help">A record written before a source was connected is never revisited.
              Attaching names retroactively would make the audit log say something today that it did not
              say yesterday — and those records would no longer verify.</div></div></div>`)}
        </div>

        <div>
          ${panel('Connect a Source', `
            <div class="row"><div class="row__label"><strong>Address list</strong>
              <div class="row__help">Fixed assignments, shared and kiosk machines. Edited here, stored on
              the appliance.</div></div>
              <button class="btn btn--sm" id="int-src-list">${id.source === 'list' ? 'Selected' : 'Use'}</button>
            </div>
            <div class="row"><div class="row__label"><strong>VDI broker or directory</strong>
              <div class="row__help">Answers who holds an address right now. Best where people work from a
              VDI pool and the mapping changes through the day.</div></div>
              <button class="btn btn--sm" id="int-src-broker">${id.source === 'broker' ? 'Selected' : 'Use'}</button>
            </div>
            ${id.source === 'broker' ? `
              <div class="row" style="display:block">
                <label class="auth__label" for="int-url">Broker URL</label>
                <input class="auth__input" id="int-url" value="${esc(id.brokerUrl ?? '')}"
                       placeholder="https://vdi.corp.internal/odata" style="margin-bottom:10px" />
                <label class="auth__label" for="int-token">Token ${id.brokerTokenSet ? '<span class="faint">(set)</span>' : ''}</label>
                <input class="auth__input" id="int-token" type="password" placeholder="${id.brokerTokenSet ? 'unchanged' : 'optional'}" />
                <button class="btn btn--sm btn--primary" id="int-save-broker">Save</button>
              </div>` : `
              <div class="row" style="display:block">
                <label class="auth__label" for="int-entries">Addresses</label>
                <div class="row__help" style="margin-bottom:6px">One per line:
                <span class="mono">address, person, department</span>. Leave the person blank for a shared
                machine — it will keep showing as an address.</div>
                <textarea id="int-entries" class="auth__input" style="height:130px;padding:8px;
                  font-family:var(--font-mono);font-size:12px">${esc(entriesText(id))}</textarea>
                <button class="btn btn--sm btn--primary" id="int-save-list">Save list</button>
              </div>`}`)}

          ${notBuilt('Audit Stream to SIEM', state.siem?.note,
            "Every decision still lands in this appliance's own audit log; a SIEM only means the SOC sees it without opening this console.")}

          ${notBuilt('Reviewer Notifications', state.notifications?.note,
            'Until it exists, a held prompt waits silently. Someone has to watch the Review Queue, or it times out and the appliance decides on its own.')}

          ${panel('Semantic Judge', `
            <div class="row"><div class="row__label"><strong>The one integration that reads prompt text</strong>
              <div class="row__help">Configured on the Monitor and Policy pages rather than here, because
              it is part of detection rather than something bolted to the side of it.</div></div>
              <a class="btn btn--sm" href="/">Monitor</a></div>`)}
        </div>
      </div>`;

    // -- wiring --
    const q = (id2) => mount.querySelector(id2);

    q('#int-toggle')?.addEventListener('click', () =>
      save({ enabled: !id.enabled }, id.enabled ? 'Identity source turned off.' : 'Identity source turned on.'));

    q('#int-src-list')?.addEventListener('click', () => save({ source: 'list' }, 'Using an address list.'));
    q('#int-src-broker')?.addEventListener('click', () => save({ source: 'broker' }, 'Using a broker.'));

    q('#int-save-list')?.addEventListener('click', () => {
      const entries = q('#int-entries').value
        .split('\n')
        .map((line) => line.split(',').map((p) => p.trim()))
        .filter(([address]) => address)
        .map(([address, person, department]) => ({ address, person: person || null, department: department || null }));
      save({ entries }, `Saved ${entries.length} address${entries.length === 1 ? '' : 'es'}.`);
    });

    q('#int-save-broker')?.addEventListener('click', () => {
      const url = q('#int-url').value.trim();
      const token = q('#int-token').value;
      // An empty token field means "leave it alone", not "clear it" - otherwise
      // saving the URL would silently drop the credential.
      save({ broker: token ? { url, token } : { url, token: undefined } }, 'Broker saved.');
    });

    q('#int-preview-go')?.addEventListener('click', () => preview(q('#int-preview-in').value.trim()));
    q('#int-preview-in')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') preview(e.target.value.trim());
    });
  }

  load();
  return null;
}

function beforeAfter() {
  const rows = [
    ['10.20.31.47', 'Noura Al-Harbi', 'Finance'],
    ['10.20.44.12', 'Khalid Al-Otaibi', 'Legal'],
    ['10.20.12.9', null, null],
  ];
  const col = (title, tone, render) => `
    <div style="flex:1;min-width:210px;padding:9px 11px;border-radius:var(--radius-sm);
         border:1px solid var(--${tone});background:var(--${tone}-weak)">
      <div style="font-size:11.5px;font-weight:600;color:var(--${tone});margin-bottom:5px">${title}</div>
      ${rows.map(render).join('')}
    </div>`;

  return `<div class="row" style="display:block">
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${col('What the console shows now', 'escalate', ([addr]) =>
        `<div class="mono" style="font-size:12px">${addr}</div>`)}
      ${col('With a source connected', 'allow', ([addr, person, dept]) =>
        person
          ? `<div style="font-size:12px"><strong>${person}</strong> <span class="muted">· ${dept}</span></div>`
          : `<div class="mono" style="font-size:12px">${addr} <span class="faint">· nobody signed in</span></div>`)}
    </div>
    <div class="row__help" style="margin-top:8px">The third address stays an address: a shared machine with
    nobody signed in is not attributed to whoever used it last.</div>
  </div>`;
}

const notBuilt = (title, note, consequence) => panel(title, `
  <div class="row"><div class="row__label">
    <strong style="color:var(--escalate)">Not built</strong>
    <div class="row__help">${esc(note ?? '')}</div></div></div>
  <div class="row"><div class="row__label"><strong>What that means meanwhile</strong>
    <div class="row__help">${esc(consequence)}</div></div></div>`);

const panel = (title, body) => `
  <div class="panel">
    <div class="panel__head"><span class="panel__title">${title}</span></div>
    <div class="panel__body panel__body--flush">${body}</div>
  </div>`;

const row = (label, value) => `
  <div class="row">
    <div class="row__label"><strong>${esc(label)}</strong></div>
    <span class="muted" style="font-size:12.5px">${esc(value ?? '—')}</span>
  </div>`;

/**
 * The stored list, as the administrator typed it. Rendering an empty textarea
 * and saving it back would quietly delete the mapping, so the round trip has
 * to carry the entries, not just a count of them.
 */
const entriesText = (id) =>
  (id.list ?? [])
    .map((e) => [e.address, e.person ?? '', e.department ?? ''].join(', ').replace(/(,\s*)+$/, ''))
    .join('\n');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
