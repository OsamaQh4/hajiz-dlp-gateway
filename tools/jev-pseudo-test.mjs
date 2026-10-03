/**
 * Can Jev help with pseudonymization and rehydration?
 *
 *   $env:OPENROUTER_API_KEY="sk-or-v1-..."
 *   node tools/jev-pseudo-test.mjs
 *
 * Jev cannot perform the substitution - it returns distributions, not text, and
 * the vault already does the replacement deterministically. What it can do is
 * three jobs the gateway currently does badly or not at all:
 *
 *   1. COREFERENCE   Our vault keys placeholders by exact string, so "Ahmed
 *                    Al-Otaibi" and a later "Al-Otaibi" become two different
 *                    people. That breaks the model's reasoning and makes
 *                    rehydration lossy. Jev can pick which existing placeholder
 *                    a span refers to, choosing only from placeholders we
 *                    already minted - so it cannot invent one.
 *
 *   2. VERIFICATION  We forward sanitized text without ever checking that the
 *                    sanitization worked. A post-substitution pass asks whether
 *                    anything non-public survived.
 *
 *   3. UTILITY       The product's central claim is that protection does not
 *                    cost usefulness. We assert that; we have never measured
 *                    it. A Score question turns it into a number.
 */
const ENDPOINT = process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions';
const MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';
const KEY = process.env.OPENROUTER_API_KEY;

if (!KEY) {
  console.error('\n  OPENROUTER_API_KEY is not set in this terminal.');
  console.error('  PowerShell:  $env:OPENROUTER_API_KEY="sk-or-v1-..."\n');
  process.exit(1);
}

const ORIGINAL =
  'Customer Ahmed Al-Otaibi (ID 1098765439) reported that Project Falcon fails auth on login. ' +
  'Al-Otaibi says the error started after the password reset. ' +
  'We are acquiring Saned next quarter and it is not yet public.';

// What the vault would have minted from Tier A's findings.
const PLACEHOLDERS = {
  PERSON_1: 'Ahmed Al-Otaibi',
  ID_1: '1098765439',
  PROJECT_1: 'Project Falcon',
  ORG_1: 'Saned',
};

// What the gateway forwards today: every located span substituted.
const SANITIZED =
  'Customer PERSON_1 (ID ID_1) reported that PROJECT_1 fails auth on login. ' +
  'Al-Otaibi says the error started after the password reset. ' +
  'We are acquiring ORG_1 next quarter and it is not yet public.';

// The same prompt, over-redacted: the last sentence replaced wholesale.
const OVER_REDACTED =
  'Customer PERSON_1 (ID ID_1) reported that PROJECT_1 fails auth on login. ' +
  'PERSON_1 says the error started after the password reset. TOPIC_1.';

const STATE = {
  description:
    'A prompt an employee is sending to an external AI assistant, before and after a DLP gateway substituted sensitive spans with placeholders.',
  original: ORIGINAL,
  placeholders: PLACEHOLDERS,
  sanitized: SANITIZED,
  over_redacted: OVER_REDACTED,
};

const QUESTIONS = {
  // 1. Coreference. Options are placeholders we already minted, so Jev cannot
  //    invent an entity - the same guarantee as picking fields from candidates.
  coref: {
    type: 'choice',
    instructions:
      'In `original`, the second sentence begins "Al-Otaibi says". Which already-minted placeholder in `placeholders` refers to the same entity as that mention?',
    criteria: {
      PERSON_1: 'The same person as the value behind PERSON_1.',
      PROJECT_1: 'The same project as the value behind PROJECT_1.',
      ORG_1: 'The same organization as the value behind ORG_1.',
      new: 'A different entity from any placeholder already minted.',
    },
  },

  // Would substituting this second mention protect anything? If "Al-Otaibi"
  // alone is as identifying as the full name, leaving it behind is a leak.
  coref_matters: {
    type: 'noul',
    instructions:
      'In `sanitized`, the bare surname "Al-Otaibi" was left unsubstituted because it does not match the string that was replaced. That remaining mention still identifies the customer.',
  },

  // 2. Verification. Did the substitution actually work?
  residual_leak: {
    type: 'noul',
    instructions:
      '`sanitized` still reveals something non-public about the organization, even though the named entities were replaced with placeholders.',
    criteria: {
      true: 'A fact, plan, relationship or weakness survives substitution - for example that an acquisition is under way and unannounced, even with the counterparty masked.',
      false: 'Nothing non-public remains once the placeholders are in place; what is left is generic.',
    },
  },

  residual_what: {
    type: 'choice',
    instructions: 'What survives substitution in `sanitized` that is still non-public?',
    criteria: {
      acquisition: 'That the organization is acquiring a company, and that it is unannounced.',
      customer_identity: 'The identity of the customer.',
      security_weakness: 'An undisclosed security weakness.',
      nothing: 'Nothing non-public survives.',
    },
  },

  // 3. Utility. Does the sanitized prompt still support the original request?
  utility_sanitized: {
    type: 'score',
    instructions:
      'How much of the original request in `original` could still be answered usefully from `sanitized` alone?',
    criteria: [
      'Nothing useful survives; the request is unanswerable.',
      'Barely answerable; most of the meaning is gone.',
      'Partly answerable; important context is missing.',
      'Mostly answerable; the placeholders stand in cleanly for the real values.',
      'Fully answerable; substitution cost nothing.',
    ],
  },

  utility_over_redacted: {
    type: 'score',
    instructions:
      'How much of the original request in `original` could still be answered usefully from `over_redacted` alone?',
    criteria: [
      'Nothing useful survives; the request is unanswerable.',
      'Barely answerable; most of the meaning is gone.',
      'Partly answerable; important context is missing.',
      'Mostly answerable; the placeholders stand in cleanly for the real values.',
      'Fully answerable; substitution cost nothing.',
    ],
  },
};

const EXPECTED = {
  coref: 'PERSON_1',
  coref_matters: 'high  — the surname still identifies',
  residual_leak: 'high  — the acquisition survives masking',
  residual_what: 'acquisition',
  utility_sanitized: '3–4  — placeholders stand in cleanly',
  utility_over_redacted: '0–2  — a whole sentence was gutted',
};

async function main() {
  console.log(`\n  endpoint : ${ENDPOINT}`);
  console.log(`  model    : ${MODEL}`);
  console.log(`  key      : ${KEY.slice(0, 8)}…${KEY.slice(-4)}\n`);

  const body = { model: MODEL, state: STATE, questions: QUESTIONS };
  const started = performance.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();

  if (!res.ok) {
    console.error(`  HTTP ${res.status}\n  ${text.slice(0, 600)}\n`);
    process.exit(1);
  }

  const json = JSON.parse(text);
  const answers = json.answers ?? json;
  console.log(`  ${Object.keys(QUESTIONS).length} questions -> ${ms} ms\n`);

  const w = (s, n) => String(s).padEnd(n);
  console.log(`  ${w('question', 22)}${w('answer', 16)}${w('conf', 7)}expected`);
  console.log('  ' + '-'.repeat(78));
  for (const [key, a] of Object.entries(answers)) {
    let got = '';
    let conf = '';
    if (a && typeof a === 'object') {
      if (typeof a.noul === 'number') got = `${(a.noul * 100).toFixed(1)}%`;
      else if (typeof a.score === 'number') got = `level ${a.score}`;
      else got = String(a.choice ?? '');
      if (a.confidence != null) conf = Number(a.confidence).toFixed(2);
    }
    console.log(`  ${w(key, 22)}${w(got, 16)}${w(conf, 7)}${EXPECTED[key] ?? ''}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(`\n  failed: ${e.message}\n`);
  process.exitCode = 1;
});
