import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { config } from '../config.js';

// Ordered by how much they protect. A redaction is stricter than a pseudonym
// because nothing is restored, but gentler than holding or refusing the request.
const ACTION_RANK = { allow: 0, pseudonymize: 1, redact: 2, escalate: 3, block: 4 };
const VALID_ACTIONS = Object.keys(ACTION_RANK);

const FALLBACK = {
  version: 0,
  name: 'built-in fallback (policy file unreadable)',
  actions: { secret: 'block', credentials: 'block' },
  default_action: 'pseudonymize',
  tier_b: { enabled: true, min_chars: 80, min_words: 12 },
  thresholds: { judge_min_confidence: 0.5, escalate_below: 0.75 },
  on_judge_error: 'warn',
  watchlist: [],
  groups: {},
};

let current = FALLBACK;
let loadedAt = 0;
let loadError = null;
let everLoaded = false;

/**
 * Check a parsed policy before it is allowed to replace a running one.
 *
 * An action name that is not one of the five is the common typo and the
 * dangerous one: `redcat` for `redact` silently falls through to the default
 * action, which is gentler than what the administrator meant to write. Caught
 * here by name rather than discovered later by a leak.
 */
export function validatePolicy(parsed) {
  const problems = [];
  if (!parsed || typeof parsed !== 'object') return ['policy is not a mapping'];

  for (const [cls, action] of Object.entries(parsed.actions ?? {})) {
    if (!VALID_ACTIONS.includes(action)) {
      problems.push(`actions.${cls}: unknown action "${action}" (expected ${VALID_ACTIONS.join(', ')})`);
    }
  }

  for (const [group, body] of Object.entries(parsed.groups ?? {})) {
    for (const [cls, action] of Object.entries(body?.actions ?? {})) {
      if (!VALID_ACTIONS.includes(action)) {
        problems.push(`groups.${group}.actions.${cls}: unknown action "${action}"`);
      }
    }
  }

  if (parsed.default_action && !VALID_ACTIONS.includes(parsed.default_action)) {
    problems.push(`default_action: unknown action "${parsed.default_action}"`);
  }

  const gate = parsed.thresholds?.sentence_hot_above;
  if (gate != null && (typeof gate !== 'number' || gate < 0 || gate > 1)) {
    problems.push('thresholds.sentence_hot_above must be a number between 0 and 1');
  }

  return problems;
}

export function loadPolicy(file = config.policyPath) {
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
    const problems = validatePolicy(parsed);
    if (problems.length) throw new Error(problems.join('; '));
    current = { ...FALLBACK, ...parsed };
    loadedAt = Date.now();
    loadError = null;
    everLoaded = true;
  } catch (err) {
    loadError = err.message;
    // A broken file must not cost an organization its policy. On the first
    // load there is nothing better than the strict built-in fallback, but on a
    // reload the last good policy keeps running and the error is reported
    // instead. Replacing a full rule set with a four-line fallback because of
    // one mistyped word is a far larger failure than refusing the edit.
    if (!everLoaded) current = FALLBACK;
  }
  return current;
}

export function getPolicy() {
  if (!loadedAt && !loadError) loadPolicy();
  return current;
}

export function policyStatus() {
  return {
    name: current.name,
    version: current.version,
    loadedAt,
    error: loadError,
    // True when a file on disk was rejected and this is the previous policy
    // still doing the work. The console has to say so: the gateway is running
    // something other than what the file says.
    stale: Boolean(loadError && everLoaded),
    path: config.policyPath,
  };
}

/** Hot reload, so a demo (or a real incident) can change policy without a restart. */
export function watchPolicy(onChange) {
  loadPolicy();
  try {
    fs.watchFile(config.policyPath, { interval: 1000 }, () => {
      loadPolicy();
      onChange?.(current);
    });
  } catch {
    /* watching is a convenience; a failure here must not take the gateway down */
  }
}

export function watchlistFor(group) {
  const p = getPolicy();
  const extra = group && p.groups?.[group]?.watchlist ? p.groups[group].watchlist : [];
  return [...(p.watchlist || []), ...extra];
}

function actionFor(cls, group) {
  const p = getPolicy();
  const override = group ? p.groups?.[group]?.actions?.[cls] : undefined;
  const chosen = override ?? p.actions?.[cls] ?? p.default_action ?? 'pseudonymize';
  return VALID_ACTIONS.includes(chosen) ? chosen : 'pseudonymize';
}

/**
 * Turn a list of findings into one decision for the request.
 *
 * @returns {{action:string, perFinding:Array, reasons:string[], toTokenize:Array, blocked:Array}}
 */
export function decide(findings, { group, judgeDegraded = false } = {}) {
  const p = getPolicy();
  const escalateBelow = p.thresholds?.escalate_below ?? 0.75;
  const perFinding = [];
  const reasons = [];

  const maxSpan = p.thresholds?.max_pseudonymize_span_chars ?? 120;

  for (const f of findings) {
    let action = actionFor(f.cls, group);
    // A judge finding we are not confident about is exactly the case that
    // should reach a person instead of being silently rewritten or blocked.
    if (action === 'pseudonymize' && f.tier === 'B' && f.confidence < escalateBelow) {
      action = 'escalate';
    }
    // Pseudonymization protects identifiers, not facts. Masking the
    // counterparty in "we are acquiring Saned next quarter, not yet public"
    // leaves the deal in plain sight - measured at 96% residual leakage. A
    // semantic finding is a fact, so it goes to a person instead.
    if (action === 'pseudonymize' && f.semantic) {
      action = 'escalate';
      reasons.push(`${f.cls} is a disclosed fact, not an identifier - substitution would not protect it`);
    }
    // An over-broad span would gut the prompt rather than sanitize it. Hand it
    // to a person instead of silently destroying what the employee asked.
    if (action === 'pseudonymize' && f.tier === 'B' && f.end - f.start > maxSpan) {
      action = 'escalate';
      reasons.push(`${f.cls} span is ${f.end - f.start} chars — too broad to substitute safely`);
    }
    perFinding.push({ ...f, action });
  }

  let action = perFinding.reduce(
    (worst, f) => (ACTION_RANK[f.action] > ACTION_RANK[worst] ? f.action : worst),
    'allow',
  );

  if (judgeDegraded) {
    const mode = p.on_judge_error ?? 'warn';
    if (mode === 'block') {
      action = 'block';
      reasons.push('semantic judge unavailable and policy fails closed');
    } else if (mode === 'warn') {
      reasons.push('semantic judge unavailable - decided on Tier A signals alone');
    }
  }

  const blocked = perFinding.filter((f) => f.action === 'block');
  for (const b of blocked) reasons.push(`${b.cls} detected by ${b.detector}`);

  // Anything not blocked and not explicitly allowed still gets pseudonymized -
  // including on an escalated request, once the reviewer approves it.
  const toTokenize = perFinding.filter(
    (f) => f.action === 'pseudonymize' || f.action === 'escalate' || f.action === 'redact',
  );

  return { action, perFinding, reasons, toTokenize, blocked };
}
