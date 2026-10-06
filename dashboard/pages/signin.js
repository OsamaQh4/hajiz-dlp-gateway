/*
 * Sign-in, and first-run provisioning.
 *
 * One of the three places imagery belongs: there is no data here and there is
 * something to say. It is also the first thing anyone sees of the product, and
 * the only screen where explaining what this is earns its space.
 *
 * The page states what the appliance is and where it sits before asking for a
 * password, because an administrator signing in wants to know what state the
 * box is in - and because a console that asks for credentials without
 * identifying itself is the shape of a phishing page.
 */

export function renderSignIn(root, { onSignedIn }) {
  let status = { provisioned: true };
  let busy = false;
  let message = null;

  const paint = () => {
    const firstRun = status.provisioned === false;

    root.innerHTML = `
      <div class="auth">
        <div class="auth__pane">
          <div class="auth__brand">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.5 4 6v6.2c0 4.6 3.2 8.4 8 9.3 4.8-.9 8-4.7 8-9.3V6l-8-3.5Z"
                    stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M12 2.5V21.5" stroke="currentColor" stroke-width="1.6" />
            </svg>
            <span>Hajiz</span>
          </div>

          <div class="orb orb--lg" style="--orb-a:#2d6a4f;--orb-b:#6aa6d6;margin:26px 0 22px"></div>

          <h1 class="auth__title">Sensitive data stops here, on its way out.</h1>
          <p class="auth__text">Hajiz sits in the network path between this organization's people and the
          internet. Every prompt bound for an external AI assistant passes through this appliance and is
          allowed, pseudonymized, redacted, held for a person or refused — inside your own network.</p>

          <div class="auth__path">
            ${['Employee device', 'Hajiz', 'Corporate proxy', 'Firewall', 'Internet']
              .map((step, i) => `<span class="auth__step${i === 1 ? ' auth__step--here' : ''}">${step}</span>`)
              .join('<span class="auth__arrow">→</span>')}
          </div>
        </div>

        <div class="auth__form">
          <form id="auth-form" autocomplete="on">
            <h2 class="auth__heading">${firstRun ? 'Create the administrator' : 'Sign in'}</h2>
            <p class="auth__sub">${
              firstRun
                ? 'This appliance has no administrator yet. The account you create here is the only one; there is no sign-up and no reset by email.'
                : 'The local administrator account, created when this gateway was installed.'
            }</p>

            <label class="auth__label" for="auth-user">Username</label>
            <input class="auth__input" id="auth-user" name="username" value="admin"
                   autocomplete="username" spellcheck="false" />

            <label class="auth__label" for="auth-pass">Password</label>
            <input class="auth__input" id="auth-pass" name="password" type="password"
                   autocomplete="${firstRun ? 'new-password' : 'current-password'}" />
            ${firstRun ? `<p class="auth__hint">At least 12 characters. Length is what makes it expensive
              to grind offline, so a long phrase beats a short puzzle.</p>` : ''}

            <button class="btn btn--primary auth__submit" type="submit" ${busy ? 'disabled' : ''}>
              ${busy ? 'Working…' : firstRun ? 'Create and sign in' : 'Sign in'}</button>

            ${message ? `<p class="auth__message auth__message--${message.kind}">${esc(message.text)}</p>` : ''}

            ${firstRun ? '' : `<div class="auth__recovery">
              <strong>Lost the password?</strong>
              <p>There is no sign-up and no email reset. Reset it from a shell on the appliance:</p>
              <code>node scripts/admin.js set-password</code>
            </div>`}

            <p class="auth__fine">Every attempt is written to the audit log. Repeated failures lock the
            account for a time.</p>
          </form>
        </div>
      </div>`;

    root.querySelector('#auth-form').addEventListener('submit', submit);
    root.querySelector(status.provisioned === false ? '#auth-pass' : '#auth-pass')?.focus();
  };

  async function submit(event) {
    event.preventDefault();
    if (busy) return;

    const username = root.querySelector('#auth-user').value.trim();
    const password = root.querySelector('#auth-pass').value;
    const firstRun = status.provisioned === false;

    busy = true;
    message = null;
    paint();

    try {
      const res = await fetch(firstRun ? '/api/auth/provision' : '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok && body.ok) {
        onSignedIn(body);
        return;
      }

      message = {
        kind: 'warn',
        text:
          body.error ??
          (body.reason === 'locked'
            ? 'Too many failed attempts. Try again later, or reset from a shell on the appliance.'
            : 'That did not work.'),
      };
      if (body.remaining != null && body.remaining > 0) {
        message.text += ` ${body.remaining} attempt${body.remaining === 1 ? '' : 's'} left before the account locks.`;
      }
    } catch (err) {
      message = { kind: 'warn', text: `Could not reach the gateway: ${err.message}` };
    } finally {
      busy = false;
      paint();
    }
  }

  (async () => {
    try {
      status = await fetch('/api/auth/status').then((r) => r.json());
    } catch {
      status = { provisioned: true };
    }
    paint();
  })();

  paint();
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
