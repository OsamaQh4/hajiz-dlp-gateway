/**
 * Configuration doctor.
 *
 *   npm run doctor
 *
 * Answers "why isn't the judge working" without guessing: what the environment
 * actually holds, what the config resolved to, and what the judge endpoint says
 * when you call it for real.
 */
import { config, judgeResidency, UPSTREAM_MODES } from '../gateway/config.js';
import { getPolicy, policyStatus } from '../gateway/policy/policy.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const ok = (s) => `${GREEN}✔${OFF} ${s}`;
const bad = (s) => `${RED}✖${OFF} ${s}`;
const warn = (s) => `${YELLOW}!${OFF} ${s}`;

/** Show enough of a secret to recognize it, never enough to use it. */
function mask(value) {
  if (!value) return null;
  if (value.length <= 10) return `${value.slice(0, 2)}…(${value.length} chars)`;
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

const VARS = [
  'DLP_PORT',
  'DLP_UPSTREAM_MODE',
  'DLP_JUDGE_PROVIDER',
  'DLP_JUDGE_MODEL',
  'DLP_JUDGE_BASE_URL',
  'DLP_JUDGE_API_KEY',
  'DLP_JUDGE_EFFORT',
  'DLP_VAULT_KEY',
  'DLP_POLICY',
  'DLP_DASHBOARD_PLAINTEXT',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

const SECRET = /KEY$/;

console.log('\n  Environment\n  ' + '-'.repeat(60));
for (const name of VARS) {
  const raw = process.env[name];
  if (raw === undefined) {
    console.log(`  ${DIM}${name.padEnd(26)} not set${OFF}`);
    continue;
  }
  const shown = SECRET.test(name) ? mask(raw) : `"${raw}"`;
  console.log(`  ${name.padEnd(26)} ${shown}`);

  // The two mistakes that cost the most time, both invisible in normal output.
  if (raw !== raw.trim()) {
    console.log(warn(`   ${name} has leading or trailing whitespace — it will be sent verbatim`));
  }
  if (/^["'].*["']$/.test(raw)) {
    console.log(warn(`   ${name} still has its quotes inside the value — PowerShell does not strip these`));
  }
}

console.log('\n  Resolved configuration\n  ' + '-'.repeat(60));
const jr = judgeResidency();
console.log(`  upstream mode              ${config.upstreamMode}`);
console.log(`  judge provider             ${config.judge.provider}`);
console.log(`  judge model                ${config.judge.model}`);
console.log(`  judge base url             ${config.judge.baseUrl ?? '(provider default)'}`);
console.log(`  judge credential           ${mask(config.judge.apiKey) ?? `${RED}none${OFF}`}`);
console.log(`  judge residency            ${jr.residency} — ${jr.host}${jr.standIn ? `  ${YELLOW}[STAND-IN]${OFF}` : ''}`);
console.log(`  policy                     ${getPolicy().name} (v${getPolicy().version})`);

console.log('\n  Checks\n  ' + '-'.repeat(60));
let problems = 0;
const fail = (m) => {
  problems += 1;
  console.log(bad(m));
};

if (!UPSTREAM_MODES.includes(config.upstreamMode)) {
  fail(`DLP_UPSTREAM_MODE is "${config.upstreamMode}" — must be one of ${UPSTREAM_MODES.join(', ')}`);
} else {
  console.log(ok(`upstream mode "${config.upstreamMode}" is valid`));
}

if (policyStatus().error) fail(`policy failed to load: ${policyStatus().error}`);
else console.log(ok('policy file parsed'));

// Provider/model mismatch: the single most common misconfiguration, because the
// model default is an Anthropic id and it survives a provider switch silently.
const looksAnthropic = /^claude-/.test(config.judge.model);
if (config.judge.provider === 'local' && looksAnthropic) {
  fail(
    `judge provider is "local" but the model is "${config.judge.model}" — that is the Anthropic default, ` +
      'which means DLP_JUDGE_MODEL was never set in this terminal',
  );
} else if (config.judge.provider === 'anthropic' && !looksAnthropic) {
  console.log(warn(`judge provider is "anthropic" but the model is "${config.judge.model}"`));
} else {
  console.log(ok(`provider and model are consistent (${config.judge.provider}:${config.judge.model})`));
}

// Copying the template and forgetting to edit it is the easiest way to end up
// with a credential that is present, well-formed, and completely useless.
const PLACEHOLDER = /(put[-_ ]?your|your[-_ ]?(real[-_ ]?)?key|replace[-_ ]?me|xxx+|changeme|key[-_ ]?here$)/i;
if (config.judge.apiKey && PLACEHOLDER.test(config.judge.apiKey)) {
  fail(
    `the judge credential is still the placeholder (ends "${config.judge.apiKey.slice(-10)}") — ` +
      'edit scripts/demo-env.ps1 and paste a real key',
  );
} else if (!config.judge.apiKey && jr.residency === 'external') {
  fail('no judge credential, and the judge host is remote — every call will return 401');
} else if (!config.judge.apiKey) {
  console.log(warn('no judge credential set (fine for a local server that needs none)'));
} else {
  console.log(ok('judge credential present'));
}

if (config.judge.baseUrl && !/\/v\d+$/.test(config.judge.baseUrl.replace(/\/$/, ''))) {
  console.log(
    warn(`DLP_JUDGE_BASE_URL is "${config.judge.baseUrl}" — OpenAI-compatible servers usually end in /v1`),
  );
}

console.log('\n  Live judge call\n  ' + '-'.repeat(60));
const probe = 'Draft a note: we are acquiring Saned next quarter and it has not been announced yet.';
const started = performance.now();
try {
  const { judge } = await import('../gateway/detect/tierB/judge.js');
  const result = await judge(probe);
  const ms = Math.round(performance.now() - started);

  if (result.degraded) {
    problems += 1;
    console.log(bad(`the judge did not answer (${ms} ms) — fell back to keyword cues`));
    console.log(`    ${RED}${result.error}${OFF}`);
    console.log(`\n  ${explain(result.error)}`);
  } else {
    console.log(ok(`the judge answered in ${ms} ms using ${result.model}`));
    console.log(`    returned ${result.findings.length} span(s):`);
    for (const f of result.findings) {
      console.log(`      ${DIM}${f.cls.padEnd(12)}${OFF} "${f.text}"  ${DIM}(${f.confidence.toFixed(2)}) ${f.rationale ?? ''}${OFF}`);
    }
    if (!result.findings.length) {
      console.log(
        warn('   the judge ran but found nothing in a prompt that clearly contains an undisclosed acquisition —\n' +
          '       the wiring works, but this model may be too weak for the job'),
      );
    }
  }
} catch (err) {
  problems += 1;
  console.log(bad(`the judge threw: ${err.message}`));
}

console.log(
  problems
    ? `\n  ${RED}${problems} problem(s) found.${OFF} Fix these before quoting any Tier B numbers.\n`
    : `\n  ${GREEN}Everything checks out.${OFF} Run: npm run bench -- --judge\n`,
);
process.exitCode = problems ? 1 : 0;

/** Turn a provider error into the thing to actually go and do. */
function explain(error = '') {
  if (/401|auth|credential/i.test(error)) {
    return (
      'A 401 means the credential never arrived or was not accepted. Check, in this order:\n' +
      '    1. Is DLP_JUDGE_API_KEY set in THIS terminal? $env: variables do not cross terminals.\n' +
      '    2. Did the whole key paste? OpenRouter keys start sk-or-v1- and are long.\n' +
      '    3. Is it an inference key, not a provisioning key?\n' +
      '    4. Does the key still exist and have credit or free-tier quota?'
    );
  }
  if (/404|not found|no endpoints/i.test(error)) {
    return (
      'A 404 usually means the model id is wrong for this host, or your account\n' +
      '    cannot reach it. On OpenRouter, free models also require the privacy setting\n' +
      '    that permits prompt training — check your account settings.'
    );
  }
  if (/429|rate/i.test(error)) {
    return (
      'Rate limited. Free endpoints are shared and throttle hard. The gateway now retries\n' +
      '    with backoff; if it still fails, drop the ":free" suffix or wait.'
    );
  }
  if (/timed out|abort/i.test(error)) {
    return (
      `The model did not finish within DLP_JUDGE_TIMEOUT_MS (${config.judge.timeoutMs} ms). Usually one of:\n` +
      '    1. A free or cold endpoint queueing the request — retry, or use a paid endpoint.\n' +
      '    2. A model that reasons or writes at length before the JSON. Classification wants a\n' +
      '       terse instruction-following model, not a reasoning or coding model.\n' +
      '    3. DLP_JUDGE_MAX_TOKENS set high, letting a chatty model ramble past the deadline.\n' +
      '    Raise the timeout ($env:DLP_JUDGE_TIMEOUT_MS="60000") to tell these apart: if it then\n' +
      '    answers in 40 s, the model is too slow for an inline gateway regardless.'
    );
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(error)) {
    return 'The judge host was unreachable. Check DLP_JUDGE_BASE_URL, and that the server is running.';
  }
  if (/JSON|parse/i.test(error)) {
    return 'The judge replied, but not with usable JSON. This model may be too small to follow the output format.';
  }
  return 'Check DLP_JUDGE_BASE_URL, DLP_JUDGE_MODEL and DLP_JUDGE_API_KEY.';
}
