/**
 * Demo driver: an ordinary API client that happens to point at the gateway
 * instead of at api.anthropic.com. Nothing here knows about DLP - that is the
 * whole integration story.
 *
 *   node scripts/demo-client.js --scenario 1 --stream
 *   node scripts/demo-client.js "any prompt you like"
 */

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const GATEWAY = flag('gateway', process.env.DLP_GATEWAY || 'http://localhost:8080');
const SESSION = flag('session', 'demo-session');
const GROUP = flag('group', null);
const STREAM = has('stream');

const SCENARIOS = {
  1: {
    title: 'Support ticket — PII + an internal codename',
    prompt: `A customer emailed us about a failed login. Draft a polite reply in English and Arabic.

Customer: Ahmed Al-Otaibi
National ID: 1098765439
Email: a.alotaibi@example.com.sa
Mobile: +966512345678
System: Project Falcon (auth service on auth-01.corp.internal)
Symptom: SSO returns 403 after the password reset, but only on the VDI image.`,
  },
  2: {
    title: 'Debugging help — with a live credential pasted in',
    prompt: `This script keeps failing with a 401, can you spot the bug?

const client = new Anthropic({ apiKey: "sk-ant-api03-Zx8Q2vK9mB4nR7tW1cY6hL0pS5dF3gJ8aE2uI9oP4kN7mQ1wX" });
const db = "postgres://svc_reporting:Tr0ub4dor&3@db-prod-01.corp.internal:5432/billing";
await client.messages.create({ model: "claude-opus-5", max_tokens: 100, messages: [] });`,
  },
  3: {
    title: 'Strategic leak — nothing a regex can ever catch',
    prompt: `Help me draft talking points for Thursday's board session. We are acquiring Saned next quarter
and we have not announced it yet; the diligence turned up an unpatched vulnerability in their payments
service. I need to explain the risk without alarming the independent directors, and outline how the
integration affects the AlUla Retail Pilot timeline.`,
  },
  4: {
    title: 'Ordinary work — nothing sensitive, nothing touched',
    prompt:
      'Explain the difference between symmetric and asymmetric encryption, and when each is appropriate for protecting data at rest. Keep it under 200 words.',
  },
};

async function main() {
  const scenarioKey = flag('scenario');
  const free = args.filter((a) => !a.startsWith('--') && !isValueOfFlag(a));
  const scenario = scenarioKey ? SCENARIOS[scenarioKey] : null;
  const prompt = scenario ? scenario.prompt : free.join(' ') || SCENARIOS[1].prompt;

  if (scenario) {
    console.log(`\n\x1b[1m${scenario.title}\x1b[0m`);
  }
  console.log('\n\x1b[2m--- what this client is sending -------------------------\x1b[0m');
  console.log(prompt);
  console.log('\x1b[2m---------------------------------------------------------\x1b[0m\n');

  const res = await fetch(`${GATEWAY}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-dlp-session': SESSION,
      ...(GROUP ? { 'x-dlp-group': GROUP } : {}),
      ...(process.env.ANTHROPIC_API_KEY ? { 'x-api-key': process.env.ANTHROPIC_API_KEY } : {}),
    },
    body: JSON.stringify({
      model: flag('model', 'claude-opus-5'),
      max_tokens: 1024,
      stream: STREAM,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok && !STREAM) {
    const err = await res.json().catch(() => ({}));
    console.log(`\x1b[31m✖ ${res.status}\x1b[0m ${err?.error?.message || JSON.stringify(err)}`);
    if (err?.dlp) console.log(`\x1b[2m  request ${err.dlp.requestId} · ${(err.dlp.reasons || []).join('; ')}\x1b[0m`);
    return;
  }

  if (STREAM) {
    if (!/text\/event-stream/.test(res.headers.get('content-type') || '')) {
      const err = await res.json().catch(() => ({}));
      console.log(`\x1b[31m✖ ${res.status}\x1b[0m ${err?.error?.message || JSON.stringify(err)}`);
      return;
    }
    process.stdout.write('\x1b[32m');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              process.stdout.write(evt.delta.text);
            }
          } catch {
            /* keepalives and comments */
          }
        }
      }
    }
    process.stdout.write('\x1b[0m\n');
    return;
  }

  const json = await res.json();
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log('\x1b[32m%s\x1b[0m', text || JSON.stringify(json, null, 2));
}

function isValueOfFlag(token) {
  const i = args.indexOf(token);
  return i > 0 && args[i - 1].startsWith('--');
}

main().catch((err) => {
  console.error(`\x1b[31mcould not reach the gateway at ${GATEWAY}\x1b[0m — ${err.message}`);
  console.error('Start it with:  npm start');
  process.exitCode = 1;
});
