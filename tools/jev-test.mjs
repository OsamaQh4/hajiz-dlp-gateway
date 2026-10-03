/**
 * Runs the Jev evaluation against OpenRouter's decisions endpoint.
 *
 *   $env:OPENROUTER_API_KEY="sk-or-v1-..."
 *   node tools/jev-test.mjs
 *
 * Sends a one-question baseline and then the full eleven-question payload, so
 * the fan-out claim is measured rather than assumed. The raw response is saved
 * for inspection; nothing here depends on guessing the response shape.
 *
 * Options:
 *   --raw        print the full JSON response
 *   --only full  skip the baseline call
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions';
const MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';
const KEY = process.env.OPENROUTER_API_KEY;
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const arg = (f, d) => (argv.indexOf(`--${f}`) === -1 ? d : argv[argv.indexOf(`--${f}`) + 1]);

if (!KEY) {
  console.error('\n  OPENROUTER_API_KEY is not set in this terminal.\n');
  console.error('  PowerShell:  $env:OPENROUTER_API_KEY="sk-or-v1-..."');
  console.error('  bash:        export OPENROUTER_API_KEY=sk-or-v1-...\n');
  process.exit(1);
}

const PROMPT =
  'Customer Ahmed Al-Otaibi (ID 1098765439) emailed a.alotaibi@example.com.sa about Project Falcon ' +
  'failing auth on auth-01.corp.internal. We are acquiring Saned next quarter and it is not yet public. ' +
  'Q3 came in at SAR 412 million, well under the plan we filed.';

const STATE = {
  description: 'An outbound prompt an employee is about to send to an external AI assistant. Judge only from `prompt`.',
  prompt: PROMPT,
};

const GATE = {
  type: 'noul',
  instructions: 'The prompt reveals something about the organization that is not already public.',
  criteria: {
    true: 'It names an identified person or customer, an internal project, undisclosed financials, a planned change such as redundancies or an acquisition, a security weakness, or a credential.',
    false: 'Routine correspondence or a general request, mentioning people, places or products without revealing anything non-public about them.',
  },
};

/** One Choice per span Tier A already located. Options are classes, plus `none`. */
const classify = (span, options) => ({
  type: 'choice',
  instructions: `Classify the span "${span}" as it is used in this prompt.`,
  criteria: { ...options, none: 'Not sensitive in this context.' },
});

const QUESTIONS = {
  gate: GATE,

  cls_id: classify('1098765439', {
    personal_identifier: 'A government or account identifier belonging to a person.',
    financial: 'An undisclosed financial figure.',
    infrastructure: 'A host, address or internal system.',
  }),
  cls_email: classify('a.alotaibi@example.com.sa', {
    contact_detail: 'Contact details identifying a person.',
    personal_identifier: 'A government or account identifier.',
  }),
  cls_host: classify('auth-01.corp.internal', {
    infrastructure: 'An internal host, address or system name.',
    project: 'An internal project or product name.',
  }),
  cls_falcon: classify('Project Falcon', {
    project: 'An internal project, codename or unreleased product.',
    infrastructure: 'An internal host or system.',
  }),
  cls_saned: classify('Saned', {
    strategic: 'A party to an undisclosed deal, acquisition or negotiation.',
    project: 'An internal project or product name.',
  }),

  // Deliberate distractors. Both should come back `none`.
  cls_q3: classify('Q3', {
    financial: 'An undisclosed financial figure or result.',
    strategic: 'An undisclosed plan or deal.',
  }),
  cls_auth: classify('auth', {
    infrastructure: 'An internal host or system name.',
    vulnerability: 'An undisclosed security weakness.',
  }),

  // Semantic leakage no regex would ever nominate as a candidate.
  sent_deal: {
    type: 'noul',
    instructions: 'The sentence "We are acquiring Saned next quarter and it is not yet public" reveals a non-public plan.',
  },
  sent_fin: {
    type: 'noul',
    instructions: 'The sentence "Q3 came in at SAR 412 million, well under the plan we filed" reveals undisclosed financial results.',
  },

  severity: {
    type: 'score',
    instructions: 'How damaging would it be if this prompt left the organization unchanged?',
    criteria: [
      'Public or already disclosed; no impact.',
      'Internal but routine; mild embarrassment at worst.',
      'Confidential business information; competitive or contractual harm.',
      'Regulated personal data or material non-public information; legal and regulatory exposure.',
      'Credentials, keys or an unfixed security weakness; immediate operational risk.',
    ],
  },
};

const EXPECTED = {
  gate: 'high',
  cls_id: 'personal_identifier',
  cls_email: 'contact_detail',
  cls_host: 'infrastructure',
  cls_falcon: 'project',
  cls_saned: 'strategic',
  cls_q3: 'none  (distractor)',
  cls_auth: 'none  (distractor)',
  sent_deal: 'high',
  sent_fin: 'high',
  severity: '3 or 4',
};

async function call(questions, label) {
  const body = { model: MODEL, state: STATE, questions };
  const started = performance.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'HTTP-Referer': 'https://github.com/OsamaQh4/hajiz-dlp-gateway',
      'X-Title': 'Hajiz DLP gateway evaluation',
    },
    body: JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the raw text for diagnosis */
  }

  if (!res.ok) {
    console.error(`\n  ${label}: HTTP ${res.status}`);
    console.error(`  ${text.slice(0, 600)}\n`);
    console.error('  If this is a 404 the endpoint path differs from what we inferred.');
    console.error('  Override it:  $env:JEV_ENDPOINT="https://..."\n');
    return { ok: false, ms, raw: json ?? text };
  }
  return { ok: true, ms, raw: json ?? text, body };
}

/** The response shape is not documented here, so find the answers wherever they are. */
function findAnswers(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.answers && typeof raw.answers === 'object') return raw.answers;
  for (const v of Object.values(raw)) {
    if (v && typeof v === 'object') {
      const nested = findAnswers(v);
      if (nested) return nested;
    }
  }
  return null;
}

function render(answers) {
  const rows = [];
  for (const [key, a] of Object.entries(answers)) {
    let got = '';
    let conf = '';
    if (a == null || typeof a !== 'object') {
      got = String(a);
    } else if (a.type === 'noul' || typeof a.noul === 'number') {
      got = `${(Number(a.noul) * 100).toFixed(1)}%`;
    } else if (a.type === 'score' || typeof a.score === 'number') {
      got = `level ${a.score}`;
      conf = a.confidence != null ? Number(a.confidence).toFixed(2) : '';
    } else {
      got = String(a.choice ?? JSON.stringify(a).slice(0, 40));
      conf = a.confidence != null ? Number(a.confidence).toFixed(2) : '';
    }
    rows.push({ key, got, conf, expected: EXPECTED[key] ?? '' });
  }

  const w = (s, n) => String(s).padEnd(n);
  console.log(`\n  ${w('question', 14)}${w('answer', 24)}${w('conf', 7)}expected`);
  console.log('  ' + '-'.repeat(70));
  for (const r of rows) console.log(`  ${w(r.key, 14)}${w(r.got, 24)}${w(r.conf, 7)}${r.expected}`);
  console.log('');
}

async function main() {
  console.log(`\n  endpoint : ${ENDPOINT}`);
  console.log(`  model    : ${MODEL}`);
  console.log(`  key      : ${KEY.slice(0, 8)}…${KEY.slice(-4)} (${KEY.length} chars)`);

  let baselineMs = null;
  if (arg('only') !== 'full') {
    const base = await call({ gate: GATE }, 'baseline (1 question)');
    if (!base.ok) process.exit(1);
    baselineMs = base.ms;
    console.log(`\n  baseline : 1 question  -> ${base.ms} ms`);
  }

  const full = await call(QUESTIONS, 'full (11 questions)');
  if (!full.ok) process.exit(1);

  const n = Object.keys(QUESTIONS).length;
  console.log(`  full     : ${n} questions -> ${full.ms} ms`);
  if (baselineMs != null) {
    const ratio = full.ms / baselineMs;
    console.log(`  fan-out  : ${ratio.toFixed(2)}x the latency for ${n}x the questions`);
    console.log(
      ratio < 2
        ? '             -> roughly flat. One round trip per request is viable.'
        : '             -> scales with question count. Re-check before building on it.',
    );
  }

  const outFile = path.join(ROOT, 'data', 'jev-result.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ request: full.body, response: full.raw }, null, 2));
  console.log(`\n  raw response saved to ${path.relative(ROOT, outFile)}`);

  const answers = findAnswers(full.raw);
  if (!answers) {
    console.log('\n  Could not locate an `answers` object in the response.');
    console.log('  Top-level keys: ' + Object.keys(full.raw ?? {}).join(', '));
    console.log('  The saved file has the full payload.\n');
    return;
  }
  render(answers);

  if (has('raw')) console.log(JSON.stringify(full.raw, null, 2));
}

main().catch((err) => {
  console.error(`\n  failed: ${err.message}\n`);
  process.exitCode = 1;
});
