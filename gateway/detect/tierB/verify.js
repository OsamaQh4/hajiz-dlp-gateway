import { config } from '../../config.js';

/**
 * Check our own work before forwarding.
 *
 * The gateway substitutes spans and sends the result without ever asking
 * whether the substitution actually worked. It does not always: masking the
 * counterparty in "we are acquiring Saned next quarter, and it is not yet
 * public" leaves the deal in plain sight. Measured at 96% residual leakage on
 * a prompt the pipeline considered sanitized.
 *
 * This is the pass that notices. It reads the sanitized text - placeholders and
 * all - and asks whether anything non-public survived. It cannot say which span
 * to fix, which is why a trip escalates to a person rather than trying again.
 *
 * Only the decision-model judge is used here. A generative judge would roughly
 * double the latency of every request for a second opinion, which is a bad
 * trade on the hot path.
 */

const LEAK_QUESTION = {
  type: 'noul',
  instructions:
    'After sensitive values were replaced with placeholders, this text still reveals something non-public about the organization.',
  criteria: {
    true: 'A fact, plan, relationship or weakness survives substitution - for example that an acquisition is under way and unannounced, or that a system has an unfixed flaw - even though the names involved are now placeholders.',
    false: 'Nothing non-public remains once the placeholders are in place. What is left is routine, generic, or already public.',
  },
};

const WHAT_QUESTION = {
  type: 'choice',
  instructions: 'What survives substitution that is still non-public?',
  criteria: {
    strategic: 'A plan, deal, acquisition or reorganisation, including the fact that it is unannounced.',
    financial: 'Undisclosed financial results or figures.',
    vulnerability: 'An undisclosed security weakness.',
    health: 'Health information about someone identifiable.',
    legal: 'Privileged or contractually confidential matter.',
    other: 'Something else non-public.',
    nothing: 'Nothing non-public survives.',
  },
};

/**
 * @returns {Promise<{checked:boolean, leaked:boolean, probability:number|null,
 *   what:string|null, reason:string|null, degraded:boolean, error:string|null}>}
 */
export async function verifySanitized(sanitized, { policy, signal } = {}) {
  const cfg = policy?.verification ?? {};
  const miss = (reason) => ({ checked: false, leaked: false, probability: null, what: null, reason, degraded: false, error: null });

  if (cfg.enabled === false) return miss('verification disabled by policy');
  if (config.judge.provider !== 'jev') return miss('verification needs the decision-model judge');
  if (!config.jev.apiKey) return miss('no judge credential');
  if (!sanitized || sanitized.trim().length < (cfg.min_chars ?? 60)) return miss('too short to verify');

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, cfg.timeout_ms ?? 6000);
  signal?.addEventListener?.('abort', () => ctrl.abort(), { once: true });

  try {
    const res = await fetch(config.jev.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.jev.apiKey}` },
      body: JSON.stringify({
        model: config.jev.model,
        state: {
          description:
            'Text already processed by a DLP gateway: sensitive values have been replaced with placeholders such as PERSON_1 or ORG_1. Judge only from `sanitized`.',
          sanitized,
        },
        questions: { leak: LEAK_QUESTION, what: WHAT_QUESTION },
      }),
      signal: ctrl.signal,
    });

    if (timedOut) throw new Error(`verification timed out after ${cfg.timeout_ms ?? 6000} ms`);
    if (!res.ok) throw new Error(`verification HTTP ${res.status}`);

    const answers = (await res.json())?.answers ?? {};
    const probability = typeof answers.leak?.noul === 'number' ? answers.leak.noul : null;
    const threshold = cfg.leak_above ?? 0.8;
    const what = answers.what?.choice ?? null;

    return {
      checked: true,
      leaked: probability != null && probability >= threshold && what !== 'nothing',
      probability,
      what: what === 'nothing' ? null : what,
      reason: null,
      degraded: false,
      error: null,
    };
  } catch (err) {
    // A verification pass that cannot run must not block the request on its
    // own - it is a second opinion, not the primary control.
    return { checked: false, leaked: false, probability: null, what: null, reason: null, degraded: true, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
