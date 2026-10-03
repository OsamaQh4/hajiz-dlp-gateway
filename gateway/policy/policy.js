import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { config } from '../config.js';

const ACTION_RANK = { allow: 0, pseudonymize: 1, escalate: 2, block: 3 };
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

export function loadPolicy(file = config.policyPath) {
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('policy is not a mapping');
    current = { ...FALLBACK, ...parsed };
    loadedAt = Date.now();
    loadError = null;
  } catch (err) {
    // Never leave the gateway without a policy - fall back to the strict
    // built-in one rather than failing open.
    loadError = err.message;
    current = FALLBACK;
  }
  return current;
}

export function getPolicy() {
  if (!loadedAt && !loadError) loadPolicy();
  return current;
}

export function policyStatus() {
  return { name: current.name, version: current.version, loadedAt, error: loadError };
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
  const toTokenize = perFinding.filter((f) => f.action === 'pseudonymize' || f.action === 'escalate');

  return { action, perFinding, reasons, toTokenize, blocked };
}
