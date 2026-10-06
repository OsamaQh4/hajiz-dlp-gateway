/*
 * The page for a route whose screen is designed but not yet built.
 *
 * It names what is missing and what still has to be written behind it, rather
 * than showing a convincing mock. A console that lies about what works is worse
 * than one with gaps in it, and during a demo the gaps are the honest answer to
 * "is this real?".
 */

const PLANNED = {
  review: {
    blurb: 'Prompts held for a person, with the countdown to the machine deciding and the trust ratchet.',
    backend: ['GET /api/escalations (exists as a count only)', 'POST /api/escalations/:id — already implemented'],
  },
  policy: {
    blurb: 'Every data class and its action, the detection gate, escalation limits, watchlist and group overrides.',
    backend: ['GET /api/policy — already implemented', 'PUT /api/policy — write back and hot-reload', 'Policy version history and rollback'],
  },
  audit: {
    blurb: 'The hash-chained record of every request, and a verification that walks the chain.',
    backend: ['GET /api/audit/verify — already implemented', 'GET /api/audit — paged records', 'Evidence bundle export'],
  },
  deployment: {
    blurb: 'The three ways traffic reaches the appliance: the network path, the endpoint agent, and a base URL for applications.',
    backend: ['Inline TLS-intercepting proxy', 'Inspection CA issuance and rollout tracking', 'Agent enrolment and version reporting'],
  },
  integrations: {
    blurb: 'Identity source mapping an address to a person, SIEM forwarding, reviewer notifications, directory groups.',
    backend: ['Identity resolver with read-only lookups', 'Syslog/CEF forwarder', 'Notification transport'],
  },
  appliance: {
    blurb: 'Console TLS and its fingerprint, administrator sign-in protection, the admin listener, policy versions, backup.',
    backend: ['Local admin account and session', 'Separate admin listener', 'Policy version store'],
  },
  api: {
    blurb: 'Integration reference: base URLs, the group header, streaming behaviour and the operational endpoints.',
    backend: ['Mostly documentation of what already exists'],
  },
  help: {
    blurb: 'Written for the employees whose prompts pass through, not for administrators.',
    backend: ['Static content'],
  },
};

/*
 * A colour pair per page, so each unbuilt screen has its own mark rather than
 * all of them sharing one. Same idea as a per-item avatar in a list: identity,
 * not decoration. Imagery is confined to pages like this one - with nothing to
 * show and something to say - and never appears over operational data.
 */
const ORBS = {
  review: ['#b06c14', '#d99b3f'],
  policy: ['#2d6a4f', '#6aa6d6'],
  audit: ['#4a4a7a', '#8a7ab8'],
  deployment: ['#1f6f7a', '#58b3b0'],
  integrations: ['#6b4ba3', '#b07fd0'],
  appliance: ['#7a4a4a', '#c08a6a'],
  api: ['#2b5f8a', '#5e9ddb'],
  help: ['#3d6b3a', '#8fb26a'],
};

export function renderPlaceholder(mount, route) {
  const plan = PLANNED[route.id] ?? { blurb: '', backend: [] };
  const [a, b] = ORBS[route.id] ?? ['#2d6a4f', '#6aa6d6'];

  mount.innerHTML = `
    <div class="pagehead__row"><h1 class="pagehead">${esc(route.label)}</h1></div>

    <div class="panel">
      <div class="emptyState">
        <div class="orb orb--lg" style="--orb-a:${a};--orb-b:${b}"></div>
        <div class="emptyState__body">
          <p class="emptyState__title">Designed, not yet built</p>
          <p class="emptyState__text">${esc(plan.blurb)}</p>
          <p class="emptyState__text" style="margin-top:10px">A mocked page that looks live is
          indistinguishable from a working one until someone relies on it, so this one says what it is.</p>
        </div>
      </div>
      <div class="panel__head" style="border-top:1px solid var(--border);border-bottom:0">
        <span class="panel__title">What this page needs behind it</span>
      </div>
      <div class="panel__body panel__body--flush">
        ${plan.backend.map((item) => `<div class="row"><div class="row__label">${esc(item)}</div></div>`).join('')}
      </div>
    </div>`;

  return null;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
