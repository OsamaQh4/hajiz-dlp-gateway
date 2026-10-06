/*
 * API — integration reference.
 *
 * Generated from the running appliance: the ports, the routes and the policy
 * groups come from /api/appliance rather than being written here beside them.
 * Documentation that is a second copy of the routing table goes stale the
 * first time the table changes, and the person it misleads is the one wiring
 * an application to a security control.
 */

export function renderApi(mount) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">API</h1>
      <span class="toolbar__sub">read from this appliance, not written alongside it</span>
      <span class="pagehead__spacer"></span>
    </div>
    <div id="api-body"></div>`;

  (async () => {
    let state;
    try {
      state = await fetch('/api/appliance').then((r) => r.json());
    } catch (err) {
      mount.querySelector('#api-body').innerHTML =
        `<div class="banner banner--warn banner--slim">Could not read the appliance: ${esc(err.message)}</div>`;
      return;
    }
    paint(mount.querySelector('#api-body'), state);
  })();

  return null;
}

function paint(el, state) {
  const api = state.api ?? {};
  const listeners = state.listeners ?? {};
  const host = location.hostname;
  const base = `http://${host}:${listeners.traffic}`;
  const adminBase = `${location.protocol}//${host}:${listeners.admin}`;

  el.innerHTML = `
    <div class="banner banner--info banner--slim">
      <span><strong>This is the third way to deploy Hajiz.</strong> Most traffic arrives through the
      network path, where nothing is configured on the client at all — see
      <a href="/deployment" style="color:var(--accent);font-weight:600">Deployment</a>. Pointing a base URL
      here is for internal applications and developers who call a model API directly.</span>
    </div>

    <div class="split">
      <div>
        ${panel('Inspected Routes', `
          <div class="row"><div class="row__help">A request to one of these is parsed, inspected and
          rewritten. Anything else on this port is proxied through untouched.</div></div>
          ${(api.routes ?? []).map((r) => `
            <div class="row">
              <div class="row__label"><strong>${esc(r.name)}</strong>
                <div class="row__help">${esc(r.name === 'anthropic' ? 'Claude and the Anthropic SDKs' : 'ChatGPT, the OpenAI SDKs, and most compatible clients')}</div></div>
              <code class="mono" style="font-size:12.5px">POST ${esc(r.route)}</code>
            </div>`).join('')}`)}

        ${panel('One Line to Adopt', `
          <div class="row" style="display:block">
            <div class="row__help" style="margin-bottom:10px">Point the client at this gateway instead of
            the provider. The request keeps the shape the provider expects, and the reply comes back with
            the original values restored — nothing in the application knows it is there.</div>
            ${code(`# Claude Code, or anything reading ANTHROPIC_BASE_URL
export ANTHROPIC_BASE_URL="${base}"

# OpenAI SDK
const client = new OpenAI({ baseURL: "${base}/v1" });

# curl
curl ${base}/v1/messages \\
  -H "content-type: application/json" \\
  -H "x-api-key: $ANTHROPIC_API_KEY" \\
  -d '{"model":"claude-sonnet-5-5","max_tokens":256,
       "messages":[{"role":"user","content":"…"}]}'`)}
          </div>`)}

        ${panel('Streaming', `
          <div class="row"><div class="row__label"><strong>Placeholders are swapped back as the text arrives</strong>
            <div class="row__help">The provider streams its reply in chunks that split wherever they like,
            often in the middle of a placeholder. The gateway holds back only as much of the tail as could
            still be the start of one — bounded by the longest placeholder in this request's map — and
            releases it as soon as it cannot be. Plain text passes straight through with no added delay.</div>
          </div></div>
          <div class="row"><div class="row__label"><strong>Tool call arguments too</strong>
            <div class="row__help">Arguments stream as JSON deltas and are restored before your SDK parses
            them, so an agent writing a file receives the real value rather than PERSON_1.</div></div></div>
          <div class="row"><div class="row__label"><strong>A placeholder the model invented</strong>
            <div class="row__help">One that is not in this session's map — PERSON_7 when only PERSON_1 and
            PERSON_2 exist — passes through unchanged rather than being guessed at.</div></div></div>`)}
      </div>

      <div>
        ${panel('Policy Group Header', `
          <div class="row"><div class="row__label"><strong>${esc(api.groupHeader ?? 'x-dlp-group')}</strong>
            <div class="row__help">Optional. Selects which group's overrides apply to the request. The
            gateway strips it before forwarding; the provider never sees it.</div></div></div>
          ${(api.groups ?? []).length
            ? (api.groups ?? []).map((g) => `<div class="row"><div class="row__label">
                <code class="mono">${esc(g)}</code></div>
                <a class="btn btn--sm" href="/policy">overrides</a></div>`).join('')
            : `<div class="row"><div class="row__help">No groups are defined in the current policy.</div></div>`}
          <div class="row"><div class="row__label"><strong>An unknown value is refused</strong>
            <div class="row__help">Rather than silently falling back to the default. A typo must not
            quietly land a request on a weaker policy.</div></div></div>`)}

        ${panel('Operational Endpoints', `
          <div class="row"><div class="row__help">${
            listeners.shared
              ? 'These share the port employee traffic arrives on. Set DLP_ADMIN_PORT to separate them.'
              : `Served on port ${listeners.admin}, away from employee traffic.`
          }</div></div>
          ${endpoint('GET', '/health', 'Liveness. The only endpoint answering on both ports, because a load balancer watches both.', adminBase)}
          ${endpoint('GET', '/api/state', 'The live numbers behind the Monitor page. Needs an administrator session.', adminBase)}
          ${endpoint('GET', '/api/audit', 'Paged audit records, newest first.', adminBase)}
          ${endpoint('GET', '/api/audit/verify', 'Walks the whole chain. Read-only: it reports a break, it never repairs one.', adminBase)}
          ${endpoint('GET', '/api/audit/export', 'Evidence bundle — records with the verification that was true when taken.', adminBase)}
          ${endpoint('GET', '/api/policy', 'The policy in force, and whether the file on disk was rejected.', adminBase)}`)}

        ${panel('Authentication', `
          <div class="row"><div class="row__label"><strong>Provider traffic</strong>
            <div class="row__help">Carries the provider's own key, forwarded as-is. No console session is
            needed or possible — employee clients have none.</div></div></div>
          <div class="row"><div class="row__label"><strong>Everything under /api</strong>
            <div class="row__help">Needs an administrator session cookie. Sign in at the console; there is
            no API token, because one more long-lived credential on an appliance with a single operator is
            a liability rather than a convenience.</div></div></div>`)}
      </div>
    </div>`;
}

const panel = (title, body) => `
  <div class="panel">
    <div class="panel__head"><span class="panel__title">${title}</span></div>
    <div class="panel__body panel__body--flush">${body}</div>
  </div>`;

const endpoint = (method, path, help, base) => `
  <div class="row">
    <div class="row__label"><strong><span class="mono" style="font-size:12px">${method}</span> ${esc(path)}</strong>
      <div class="row__help">${esc(help)}</div></div>
    <button class="btn btn--sm" onclick="navigator.clipboard?.writeText('${esc(base + path)}')">Copy</button>
  </div>`;

const code = (text) => `
  <pre class="mono" style="white-space:pre-wrap;font-size:12px;margin:0;padding:11px;
       background:var(--surface-sunken);border:1px solid var(--border);
       border-radius:var(--radius-sm)">${esc(text)}</pre>`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
