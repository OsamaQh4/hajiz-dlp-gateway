/*
 * Deployment — the three ways traffic reaches this appliance.
 *
 * Ordered by how much traffic each carries in a real installation, not by how
 * easy each was to build. The network path is the product; the base URL is a
 * developer convenience that happens to have been implemented first.
 *
 * The agent is listed as not built rather than shown as an empty fleet. A
 * table reading "0 machines enrolled" says the rollout has not started; what
 * is true is that the thing does not exist, and the difference matters to
 * anyone deciding whether laptops off the network are covered. They are not.
 */

export function renderDeployment(mount, { store }) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">Deployment</h1>
      <span class="toolbar__sub">how prompts reach this appliance</span>
      <span class="pagehead__spacer"></span>
    </div>
    <div id="dep-body"><div class="empty">Reading…</div></div>`;

  const load = async () => {
    try {
      const data = await fetch('/api/deployment').then((r) => r.json());
      paint(mount.querySelector('#dep-body'), data);
    } catch (err) {
      mount.querySelector('#dep-body').innerHTML =
        `<div class="banner banner--warn banner--slim">Could not read the deployment state: ${esc(err.message)}</div>`;
    }
  };

  load();
  const unsubscribe = store.subscribe(() => load());
  return { stop: unsubscribe };
}

function paint(el, data) {
  const np = data.networkPath ?? {};
  const traffic = data.traffic ?? {};
  const total = Object.values(traffic).reduce((a, b) => a + b, 0);
  const share = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : '—');

  el.innerHTML = `
    ${np.enabled ? '' : `<div class="banner banner--warn banner--slim">
      <span class="dot dot--warn" style="margin-top:4px"></span>
      <span><strong>The in-path proxy is not running.</strong> Only applications explicitly pointed at this
      gateway are inspected. Set DLP_PROXY_PORT to put the appliance in the network path, where employees
      configure nothing.</span></div>`}

    <div class="metrics" style="margin-bottom:12px">
      ${mode('Network path', traffic.network ?? 0, share(traffic.network ?? 0),
             np.enabled ? `live on port ${np.port}` : 'not running', np.enabled)}
      ${mode('Endpoint agent', traffic.agent ?? 0, share(traffic.agent ?? 0), 'not built', false)}
      ${mode('Base URL', traffic.baseurl ?? 0, share(traffic.baseurl ?? 0),
             `port ${data.baseUrl?.port ?? '—'}`, true)}
    </div>

    <div class="split">
      <div>
        ${panel('1 · Network Path', `
          <div class="row"><div class="row__help">Traffic from VDIs and managed laptops is routed through
          this appliance, then on to the corporate proxy, the firewall and the internet. Employees keep
          using claude.ai and ChatGPT exactly as before and install nothing. This is the mode the product
          is for.</div></div>
          ${path()}
          <div class="row"><div class="row__label"><strong>How to turn it on</strong>
            <div class="row__help">Start the gateway with DLP_PROXY_PORT set, point managed machines at it
            as their HTTPS proxy, and distribute the inspection CA below. Nothing changes for the
            employee.</div></div></div>`)}

        ${panel('What Is Opened, And What Is Not', `
          <div class="row"><div class="row__help">Interception is an allow-list. Everything not named here
          is tunnelled as bytes and never decrypted — the appliance learns the hostname and nothing
          else.</div></div>
          <div class="row" style="display:block">
            <div class="metric__label" style="margin-bottom:6px">Decrypted and inspected · ${(np.inspect ?? []).length}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${(np.inspect ?? []).map((h) => chip(h, 'pseudonymize')).join('')}</div>
          </div>
          <div class="row" style="display:block">
            <div class="metric__label" style="margin-bottom:6px">Deliberately passed through · ${(np.neverIntercept ?? []).length}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${(np.neverIntercept ?? []).map((h) => chip(h, 'allow')).join('')}</div>
            <div class="row__help" style="margin-top:8px">These pin their certificates. Terminating TLS on
            them does not fail safely — the application simply stops working, with an error that looks like
            anything but a proxy.</div>
          </div>`)}

        ${panel('2 · Endpoint Agent', `
          <div class="row"><div class="row__label">
            <strong style="color:var(--escalate)">Not built</strong>
            <div class="row__help">${esc(data.agent?.note ?? '')}</div></div></div>
          <div class="row"><div class="row__label"><strong>What it would cover</strong>
            <div class="row__help">A laptop that leaves the corporate network cannot be routed through this
            appliance, so its prompts are not inspected at all. Until the agent exists, that gap is real and
            the honest answer to "are we covered" is: on the network, yes; off it, no.</div></div></div>`)}

        ${panel('3 · Base URL', `
          <div class="row"><div class="row__label"><strong>For applications and developers</strong>
            <div class="row__help">An internal application points its base URL at this gateway instead of
            the provider. Useful, and the smallest of the three — it only covers code someone deliberately
            configured.</div></div>
            <a class="btn btn--sm" href="/api">Reference</a></div>`)}
      </div>

      <div>
        ${np.enabled && np.ca ? panel('Inspection CA', `
          <div class="row"><div class="row__help">To read a prompt on its way to an AI assistant, this
          appliance terminates the TLS connection. That only works on machines that have been told to trust
          this certificate — which is a decision the organization makes deliberately, and the reason the
          subject names it for what it is.</div></div>
          ${row('Subject', np.ca.subject)}
          ${row('Expires', `${String(np.ca.validTo).slice(0, 10)} (${np.ca.expiresInDays} days)`)}
          ${row('Leaf lifetime', `${np.ca.leafDays} days`)}
          ${row('Certificates minted', `${np.ca.minted} this boot`)}
          <div class="row" style="display:block">
            <div class="metric__label" style="margin-bottom:6px">SHA-256 fingerprint</div>
            <code class="mono" style="display:block;font-size:11.5px;line-height:1.7;word-break:break-all">${esc(np.ca.fingerprint ?? '')}</code>
            <div class="row__help" style="margin-top:8px">Compare this against the printout from
            installation before distributing it.</div>
          </div>
          <div class="row">
            <div class="row__label"><strong>Distribute to managed machines</strong>
              <div class="row__help">Push by GPO or Intune. The private key has no route out of this
              appliance and is not in this download.</div></div>
            <a class="btn btn--sm btn--primary" href="/api/deployment/ca.crt" download>Download</a>
          </div>
          ${row('On disk', np.ca.certPath, true)}`) : ''}

        ${panel('A Machine That Does Not Trust It', `
          <div class="row"><div class="row__label"><strong>Gets a certificate warning, and cannot proceed</strong>
            <div class="row__help">That is the intended failure. The alternative — waving through traffic
            the appliance cannot read — would mean the machines least under management are the ones whose
            prompts are never inspected.</div></div></div>`)}

        ${panel('Every Route, One Inspection', `
          <div class="row"><div class="row__help">How a prompt arrives changes nothing about how it is
          judged. The same two tiers, the same policy, the same audit record.</div></div>
          <div class="row"><div class="row__label"><strong>Monitor</strong>
            <div class="row__help">Shows all three together</div></div>
            <a class="btn btn--sm" href="/">Open</a></div>`)}
      </div>
    </div>`;
}

function path() {
  const steps = [
    ['Employee device', 'VDI or managed laptop'],
    ['Hajiz', 'inspects AI-bound traffic'],
    ['Corporate proxy', 'unchanged'],
    ['Firewall', 'unchanged'],
    ['Internet', 'claude.ai · chatgpt.com'],
  ];
  return `<div class="row" style="display:block">
    <div style="display:flex;gap:6px;align-items:stretch;flex-wrap:wrap">
      ${steps.map(([name, note], i) => `
        <div style="flex:1;min-width:112px;padding:8px 10px;border-radius:var(--radius-sm);
             border:1px solid var(--${i === 1 ? 'accent' : 'border'});
             background:var(--${i === 1 ? 'accent-weak' : 'surface-sunken'})">
          <div style="font-size:12.5px;font-weight:600;color:var(--${i === 1 ? 'accent' : 'text'})">${name}</div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">${note}</div>
        </div>`).join('')}
    </div></div>`;
}

const mode = (name, count, pct, note, on) => `
  <div>
    <div class="metric__label">
      <span class="dot ${on ? 'dot--live' : 'dot--off'}" style="display:inline-block;vertical-align:middle"></span>
      ${name}</div>
    <div class="metric__value">${count.toLocaleString()}</div>
    <div class="metric__note">${pct} · ${esc(note)}</div>
  </div>`;

const chip = (text, tone) => `
  <span class="mono" style="font-size:11.5px;padding:3px 8px;border-radius:99px;
        background:var(--${tone}-weak);color:var(--${tone})">${esc(text)}</span>`;

const panel = (title, body) => `
  <div class="panel">
    <div class="panel__head"><span class="panel__title">${title}</span></div>
    <div class="panel__body panel__body--flush">${body}</div>
  </div>`;

const row = (label, value, mono = false) => `
  <div class="row">
    <div class="row__label"><strong>${esc(label)}</strong></div>
    <span class="${mono ? 'mono ' : ''}muted" style="font-size:12.5px;text-align:right;word-break:break-all;max-width:60%">${esc(value ?? '—')}</span>
  </div>`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
