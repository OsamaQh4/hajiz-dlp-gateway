/*
 * Help — written for the people whose prompts pass through, not for the
 * administrator reading the rest of this console.
 *
 * That audience changes what belongs here. They did not install Hajiz, cannot
 * turn it off, and most of them will arrive after a prompt was refused and
 * they want to know what to change. So the page leads with what happened and
 * what to do, and explains the mechanism second.
 *
 * The thresholds are read from the live policy: a help page quoting ninety
 * seconds at an organization that set five minutes is worse than one that
 * quotes nothing, because it will be believed.
 */

export function renderHelp(mount, { store }) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">Help</h1>
      <span class="toolbar__sub">for everyone whose prompts pass through this gateway</span>
      <span class="pagehead__spacer"></span>
    </div>
    <div id="help-body"></div>`;

  const unsubscribe = store.subscribe((state) => paint(mount.querySelector('#help-body'), state));
  return { stop: unsubscribe };
}

function paint(el, state) {
  const wait = Math.round((state.escalation?.wait_for_human_ms ?? 90000) / 1000);
  const actions = state.actions ?? {};
  const observing = state.enforcement !== 'enforce';

  el.innerHTML = `
    ${observing ? `<div class="banner banner--info banner--slim">
      <span><strong>This gateway is in observe mode.</strong> Prompts are inspected and recorded, and
      forwarded exactly as written. Nothing below about refusals or placeholders is happening yet.</span>
    </div>` : ''}

    <div class="split">
      <div>
        ${panel('What This Is', `
          <div class="row"><div class="row__label">
            <strong>You did not install it and cannot turn it off</strong>
            <div class="row__help">Your organization routes AI traffic through this appliance. You keep
            using claude.ai, ChatGPT and the rest exactly as before — nothing is installed on your machine
            and no setting of yours changes. Every prompt on its way out passes through here first.</div>
          </div></div>
          <div class="row"><div class="row__label">
            <strong>Most prompts go straight through</strong>
            <div class="row__help">The majority are allowed untouched. Something only happens when the
            prompt contains data that should not leave the company.</div></div></div>`)}

        ${panel('If Your Prompt Is Refused', `
          <div class="row"><div class="row__label"><strong>1 · Read the reason</strong>
            <div class="row__help">The notice names what was found, and for text you pasted, roughly
            where. That is the only part you need to change.</div></div></div>
          <div class="row"><div class="row__label"><strong>2 · Describe it instead of pasting it</strong>
            <div class="row__help">The assistant rarely needs the real value. "A 34-character API key"
            usually helps it as much as the key itself, and "a customer in Jeddah" as much as the name.</div>
          </div></div>
          <div class="row"><div class="row__label"><strong>3 · Send the edited prompt</strong>
            <div class="row__help">It is checked again from scratch. There is no penalty for trying
            again, and nothing is held against you.</div></div></div>
          <div class="row"><div class="row__label"><strong>4 · If it was held rather than refused</strong>
            <div class="row__help">Someone on the security team is reading it. Wait — resending puts a
            second copy in the same queue and slows the first one down. If nobody answers within
            ${wait} seconds the appliance decides on its own.</div></div></div>
          <div class="row"><div class="row__label"><strong>5 · If you think it was wrong</strong>
            <div class="row__help">Tell your security team and quote the reference on the notice, never
            the sensitive value itself. The reference is enough for them to find the decision.</div></div></div>`)}

        ${panel('Rephrasing, By Example', `
          ${example(
            'Why does boto3 fail with this? aws_secret_access_key = wJalrXUtn…',
            'My boto3 client reads aws_secret_access_key from an environment variable. Why would it say no credentials were found?',
            'The key is gone; the question is unchanged.')}
          ${example(
            'Write to Al-Noor counsel that we will pay SAR 2.1M and they withdraw the claim by 30 Nov.',
            'Draft a short, formal email confirming that both parties accept the settlement terms agreed in the last meeting.',
            'The purpose is kept; the terms are left out.')}
          ${example(
            'Check this customer list for duplicates: 1084523311, 1092214870, …',
            'Write an Excel formula that flags duplicate 10-digit IDs in column B.',
            'Asks for the method, and you run it yourself.')}`)}
      </div>

      <div>
        ${panel('Why a Password Never Comes Back', `
          <div class="row"><div class="row__label">
            <strong><span class="pill pill--pseudonymize">pseudonymize</span> comes back</strong>
            <div class="row__help">A name, an email address, a phone number or an account number is
            swapped for a placeholder on the way out, and the real value is put back into the reply before
            you see it. The assistant never saw it; you never notice it was gone.</div></div></div>
          <div class="row"><div class="row__label">
            <strong><span class="pill pill--redact">redact</span> never comes back</strong>
            <div class="row__help">A password, key or token is removed outright, and nothing restores it.
            Three reasons: the assistant does not need the real secret to help with a login error, there is
            nothing to restore because no copy is kept, and replies travel — into chat history, tickets and
            screenshots — so a secret that appears in one will eventually leak.</div></div></div>
          ${Object.entries(actions).length ? `<div class="row"><div class="row__help">
            On this gateway, credentials are set to
            <strong>${esc(actions.credentials ?? 'redact')}</strong> and secrets to
            <strong>${esc(actions.secret ?? 'block')}</strong>.</div></div>` : ''}`)}

        ${panel('How Placeholders Work', `
          <div class="row" style="display:block">
            <div class="row__help" style="margin-bottom:10px">You write a name. The assistant sees
            PERSON_1. The reply comes back with the real name already in place.</div>
            ${flow()}
          </div>
          <div class="row"><div class="row__label"><strong>The same value keeps the same placeholder</strong>
            <div class="row__help">Within a conversation, so the assistant can still follow who is
            who.</div></div></div>
          <div class="row"><div class="row__label"><strong>Write normally</strong>
            <div class="row__help">You never need to anonymise by hand. Typing initials or "my colleague"
            only makes the reply less useful.</div></div></div>
          <div class="row"><div class="row__label"><strong>Copying a reply is safe</strong>
            <div class="row__help">What you copy is what you see, with the real values already
            restored.</div></div></div>`)}

        ${panel('Arabic', `
          <div class="row"><div class="row__label">
            <strong>Prompts in Arabic are inspected exactly as English ones are</strong>
            <div class="row__help">Names, national IDs, IBANs and internal codenames are recognised in
            both scripts. Writing in Arabic is not a way around the policy, and it is not a reason to
            expect worse results.</div></div></div>`)}

        ${panel('Common Questions', `
          ${qa('The reply says PERSON_1 instead of a name',
               'The assistant reformatted the placeholder, so it was not recognised on the way back. Ask it to keep placeholders exactly as written, then try again.')}
          ${qa('Part of my pasted code came back redacted',
               'A secret was found and removed before sending. The rest of the code went through. If the assistant needs that value, refer to it by name.')}
          ${qa('My prompt has said "held for a reviewer" for a while',
               'Someone is reading it. Do not resend — copies join the same queue.')}
          ${qa('Something harmless was blocked',
               'Patterns sometimes match things that only look sensitive, such as a long reference number. Tell your security team and quote the reference, not the text.')}
          ${qa('Some replies take a second longer',
               'Those prompts went to the second layer, which reads for meaning. Expected on sensitive topics.')}
          ${qa('I need to send real customer data for my work',
               'Ask your manager to request an exception from the security team. The same rules apply to everyone, and this gateway cannot be switched off for one message.')}`)}
      </div>
    </div>`;
}

function flow() {
  const box = (label, body, tone) => `
    <div style="flex:1;min-width:0;padding:9px 11px;border-radius:var(--radius-sm);
                border:1px solid var(--${tone});background:var(--${tone}-weak)">
      <div style="font-size:11.5px;color:var(--${tone});font-weight:600;margin-bottom:3px">${label}</div>
      <div class="mono" style="font-size:12px">${body}</div>
    </div>`;
  return `<div style="display:flex;gap:8px;align-items:stretch;flex-wrap:wrap">
    ${box('You write', 'Email <strong>Noura Al-Shehri</strong> about Sunday', 'allow')}
    ${box('Claude sees', 'Email <strong>PERSON_1</strong> about Sunday', 'pseudonymize')}
    ${box('You read', 'Dear <strong>Noura Al-Shehri</strong>, …', 'allow')}
  </div>`;
}

const panel = (title, body) => `
  <div class="panel">
    <div class="panel__head"><span class="panel__title">${title}</span></div>
    <div class="panel__body panel__body--flush">${body}</div>
  </div>`;

const example = (stopped, works, why) => `
  <div class="row" style="display:block">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <div style="flex:1;min-width:200px">
        <div style="font-size:11.5px;color:var(--block);font-weight:600;margin-bottom:3px">stopped</div>
        <div class="mono" style="font-size:12px;color:var(--text-muted)">${esc(stopped)}</div>
      </div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:11.5px;color:var(--allow);font-weight:600;margin-bottom:3px">goes through</div>
        <div class="mono" style="font-size:12px">${esc(works)}</div>
      </div>
    </div>
    <div class="row__help">${esc(why)}</div>
  </div>`;

const qa = (question, answer) => `
  <div class="row"><div class="row__label"><strong>${esc(question)}</strong>
    <div class="row__help">${esc(answer)}</div></div></div>`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
