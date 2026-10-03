import { config } from '../../config.js';

/**
 * What happens when a prompt is escalated and no human answers.
 *
 * Failing closed on every timeout trains people to route around the gateway;
 * failing open silently is worse. So the decision model takes the call - but
 * only for as long as that stays safe.
 *
 * Trust ratchets. Each consecutive decision taken without a human is counted,
 * and once the run exceeds the administrator's limit every later timeout is a
 * block regardless of what the model says. An unattended queue gets stricter,
 * never more permissive. A single human answer resets the run.
 *
 * The question asked here is deliberately *not* the one that caused the
 * escalation. The judge already said what the span is; asking again would be
 * the same model confirming itself. This asks whether forwarding is acceptable
 * given that nobody reviewed it, which is new information.
 */

const runs = new Map();

const keyFor = (scope, { sessionId, group }) =>
  scope === 'global' ? 'global' : scope === 'group' ? `group:${group ?? 'none'}` : `session:${sessionId}`;

/** A human answered, so the unattended run is over. */
export function recordHumanDecision({ sessionId, group, policy }) {
  runs.delete(keyFor(policy?.escalation?.counter_scope ?? 'session', { sessionId, group }));
}

export function consecutiveAutoDecisions({ sessionId, group, policy }) {
  return runs.get(keyFor(policy?.escalation?.counter_scope ?? 'session', { sessionId, group })) ?? 0;
}

export function resetAll() {
  runs.clear();
}

/**
 * @returns {Promise<{approved:boolean, by:string, reason:string,
 *   confidence:number|null, consecutive:number, degraded:boolean}>}
 */
export async function adjudicateUnreviewed({ sanitized, decision, sessionId, group, policy, signal }) {
  const cfg = policy?.escalation ?? {};
  const scope = cfg.counter_scope ?? 'session';
  const limit = cfg.auto_decisions_before_block ?? 3;
  const key = keyFor(scope, { sessionId, group });
  const already = runs.get(key) ?? 0;

  // The ratchet. Past the limit, nothing the model says can approve it.
  if (already >= limit) {
    runs.set(key, already + 1);
    return {
      approved: false,
      by: 'ratchet',
      reason: `blocked: ${already} consecutive decisions already taken without a human (limit ${limit})`,
      confidence: null,
      consecutive: already + 1,
      degraded: false,
    };
  }

  const classes = [...new Set(decision.perFinding.filter((f) => f.action === 'escalate').map((f) => f.cls))];

  let approved = false;
  let confidence = null;
  let degraded = false;
  let reason;

  if (config.judge.provider !== 'jev' || !config.jev.apiKey) {
    reason = 'no decision model available, so the request fails closed';
    degraded = true;
  } else {
    try {
      const answers = await ask({ sanitized, classes, signal, timeoutMs: cfg.judge_timeout_ms ?? 8000 });
      const choice = answers.verdict?.choice;
      confidence = typeof answers.verdict?.confidence === 'number' ? answers.verdict.confidence : null;
      const floor = cfg.min_confidence ?? 0.75;

      if (choice === 'forward' && confidence != null && confidence >= floor) {
        approved = true;
        reason = `forwarded unreviewed: substitution judged sufficient (${Math.round(confidence * 100)}%)`;
      } else if (choice === 'forward') {
        reason = `held: substitution judged sufficient but only at ${Math.round((confidence ?? 0) * 100)}%, under the ${Math.round(floor * 100)}% bar`;
      } else {
        reason = 'blocked: substitution judged insufficient to protect what this reveals';
      }
    } catch (err) {
      degraded = true;
      reason = `blocked: the adjudicator could not be reached (${err.message})`;
    }
  }

  const consecutive = already + 1;
  runs.set(key, consecutive);

  return { approved, by: degraded ? 'fail-closed' : 'judge', reason, confidence, consecutive, degraded };
}

async function ask({ sanitized, classes, signal, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener?.('abort', () => ctrl.abort(), { once: true });

  try {
    const res = await fetch(config.jev.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.jev.apiKey}` },
      body: JSON.stringify({
        model: config.jev.model,
        state: {
          description:
            'A prompt was held for human review and nobody answered in time. Sensitive values have already been replaced with placeholders. Decide whether sending it unreviewed is acceptable.',
          sanitized,
          flagged_categories: classes,
        },
        questions: {
          verdict: {
            type: 'choice',
            instructions:
              'No reviewer is available. Is it acceptable to send `sanitized` to an external AI provider as it stands?',
            criteria: {
              forward:
                'What remains after substitution is routine or generic. The placeholders carry the sensitive values, and nothing non-public survives in the text itself.',
              hold: 'Something non-public survives substitution, or the text is ambiguous enough that a person should see it before it leaves.',
            },
          },
        },
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json())?.answers ?? {};
  } finally {
    clearTimeout(timer);
  }
}
