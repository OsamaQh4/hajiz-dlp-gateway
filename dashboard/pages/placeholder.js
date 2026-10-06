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

export function renderPlaceholder(mount, route) {
  const plan = PLANNED[route.id] ?? { blurb: '', backend: [] };

  mount.innerHTML = `
    <p class="eyebrow">${esc(route.label)}</p>
    <h1 class="display">Designed, not yet built.</h1>
    <p class="lede">${esc(plan.blurb)}</p>

    <div class="notBuilt" style="margin-top:24px">
      <h3>What this page needs behind it</h3>
      <ul style="margin:8px 0 0;padding-left:18px">
        ${plan.backend.map((b) => `<li style="margin-bottom:4px">${esc(b)}</li>`).join('')}
      </ul>
    </div>

    <p class="stat__note" style="margin-top:18px;max-width:62ch">
      The approved design for this screen is in <span class="mono">designs/</span>. This placeholder is
      deliberate: a mocked page that looks live is indistinguishable from a working one until someone
      relies on it.
    </p>`;

  return null;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
