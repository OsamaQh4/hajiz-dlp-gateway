import { config } from '../../config.js';

/**
 * Tier B using a decision model (TypeSafe's Jev) instead of a generative judge.
 *
 * The difference that matters is not speed. A generative judge writes spans,
 * so it can invent one, and every span it returns has to be located in the text
 * afterwards and discarded if it was never there. A decision model only ever
 * *chooses* - from sentences we split, or from spans Tier A already located -
 * so a hallucinated span is not filtered out, it is impossible to express.
 *
 * Two kinds of question go out in a single request:
 *
 *   SENTENCES   One Choice per sentence, over the taxonomy plus `none`. This is
 *               the semantic layer: leaks no pattern would ever nominate.
 *
 *   CANDIDATES  One Choice per low-confidence Tier A hit. Tier A fires on
 *               source code constantly - model ids, slugs, lockfile hashes -
 *               and this is where those get thrown out, by something that can
 *               read context. High-confidence hits (a checksum-validated
 *               national ID) are not re-litigated; they are already certain.
 */

export const TAXONOMY = {
  person: 'The name of an identifiable individual - a customer, employee or patient.',
  org: 'A customer, partner or supplier whose relationship with us is not public.',
  project: 'A specific internal project, codename, internal system or unreleased product.',
  financial: 'A specific undisclosed figure, result or amount. A bare period label such as a quarter or a year is not financial.',
  strategic: 'A specific undisclosed plan, deal, acquisition, reorganisation or negotiation, or the fact that one is unannounced.',
  credentials: 'A password, key, token or other secret that grants access.',
  vulnerability: 'A specific undisclosed security weakness in our systems, including a failed or unfinished control.',
  health: 'Medical or health information about an identifiable person.',
  legal: 'Privileged advice, litigation strategy or contract terms under an obligation of confidence.',
  source_code: 'Proprietary source code, schemas or infrastructure configuration.',
  location: 'A place or facility, but only where the text also reveals something non-public about it.',
  internal_host: 'A specific internal host, address or system name. A generic technical word is not.',
};

const NONE =
  'A generic word, label, period or common technical term that identifies nothing specific and reveals nothing non-public on its own. Replacing it would protect nothing.';

/**
 * Split into units to judge, keeping offsets so findings stay locatable.
 *
 * A part shorter than `minChars` used to be dropped here, on the reasoning
 * that a fragment is too small to hide a semantic leak. That holds for prose
 * and is false for precisely the thing this product exists to stop. A password
 * sits on a line of its own, is ten characters long, and has no sentence around
 * it. Observed live: a file containing
 *
 *     Email: someone@example.com
 *     7-2jkLm#qz
 *
 * produced zero sentences, so the judge was never asked a single question about
 * it, and the credential left the network while Tier A was busy not finding a
 * `Password:` label in front of it. Two layers failed for unrelated reasons
 * that coincide exactly on the shape of a real secret: short, unlabelled, and
 * alone on a line. The model on the other end then pointed it out unasked.
 *
 * So nothing is dropped now. Every part holding a letter or a digit is judged,
 * and a part too short to speak for itself carries its neighbours as context
 * for the question.
 *
 * Short parts are deliberately *not* merged into larger units, though merging
 * would cost fewer questions. A unit spanning both lines above would be
 * classified `credentials` and the whole span replaced - taking the email with
 * it. One unit per part keeps spans tight, so what gets substituted is the
 * secret and not the paragraph around it. The cost is more questions on
 * line-broken text, which is what the cap in judgeWithJev bounds.
 */
export function sentences(text, { minChars = 30, contextChars = 200 } = {}) {
  const parts = [];
  const re = /(?<=[.!?])\s+|\n+/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  parts.push({ start, end: text.length });

  return parts
    .map((p) => ({ ...p, text: text.slice(p.start, p.end) }))
    // Punctuation and bare delimiters - `}`, `---`, the segment separator -
    // can hold neither an identifier nor a secret, so they are not worth a
    // question. Anything with a letter or a digit in it is.
    .filter((p) => /[\p{L}\p{N}]/u.test(p.text))
    .map((p) =>
      p.text.trim().length >= minChars
        ? p
        : {
            ...p,
            context: text.slice(Math.max(0, p.start - contextChars), Math.min(text.length, p.end + contextChars)),
          },
    );
}

/**
 * How a unit is put to the judge. One long enough to stand alone is asked
 * about in the wording the head-to-head benchmark was measured on, unchanged.
 * A short one is asked differently, because ten characters tell the judge
 * nothing while the lines around them say "this is a credentials dump" - and
 * the question has to say the context is background, or the judge answers
 * about the context and the finding lands on the wrong span.
 */
const HOT_FALSE =
  'Routine correspondence, a general question, or a technical request. It mentions people, places, products or systems without revealing anything non-public about them. Naming a facility, product or technology on its own is not sensitive.';

/**
 * The criteria the head-to-head benchmark was measured on. Not to be edited
 * without re-running it: a Noul weighs the two descriptions against each other,
 * so adding a clause to `true` makes `true` heavier for every sentence, not
 * only for the sentences the clause is about.
 *
 * Measured. Appending "a value that looks like a password counts even with no
 * label in front of it" here - correct, and aimed at short lines - cost span
 * precision 90.9% -> 83.3% by flagging two long instruction sentences, "Write a
 * one-page mitigation plan..." and "Help me explain the variance...", neither
 * of which contains anything resembling a credential. Recall did not move. So
 * the clause lives on the short-line variant below, where it is needed and
 * where there is no long sentence for it to tip over.
 */
const HOT_TRUE_SENTENCE =
  'It reveals an identified person or customer, an internal project or codename, undisclosed financials, a planned change such as redundancies or an acquisition, a security weakness, or a credential. A place, facility, product or system counts only when the sentence also reveals something non-public about it.';

const HOT_TRUE_LINE =
  'It reveals an identified person or customer, an internal project or codename, undisclosed financials, a planned change such as redundancies or an acquisition, a security weakness, or a credential. A value that looks like a password, key or token counts even with no label in front of it. A place, facility, product or system counts only when the text also reveals something non-public about it.';

const hotQuestion = (s) =>
  s.context
    ? {
        type: 'noul',
        instructions: `This line reveals something about the organization that is not already public: "${clip(s.text, 120)}". Judge that line only. It is shown here with the text around it purely as context: "${clip(s.context)}"`,
        criteria: { true: HOT_TRUE_LINE, false: HOT_FALSE },
      }
    : {
        type: 'noul',
        instructions: `This sentence reveals something about the organization that is not already public: "${clip(s.text)}"`,
        criteria: { true: HOT_TRUE_SENTENCE, false: HOT_FALSE },
      };

const choice = (instructions, options) => ({
  type: 'choice',
  instructions,
  criteria: { ...options, none: NONE },
});

/**
 * @param {string} text - the joined request text
 * @param {Array} tierA - findings Tier A already located, with offsets
 * @returns {Promise<{findings:Array, suppressed:Array, gate:number|null, severity:number|null, degraded:boolean, error:string|null, model:string}>}
 */
export async function judgeWithJev(text, tierA = [], { policy, signal } = {}) {
  const adjudicateBelow = policy?.thresholds?.adjudicate_below ?? 0.9;
  const minConfidence = policy?.thresholds?.judge_min_confidence ?? 0.5;

  const all = sentences(text);
  // Each unit costs two questions, so the count is capped. The truncation is
  // reported rather than silent: a request whose tail was never inspected is
  // not the same thing as a request that came back clean.
  const maxSents = Number(process.env.DLP_SENTENCE_MAX ?? policy?.thresholds?.max_sentences ?? 40);
  const sents = all.slice(0, maxSents);
  const truncated = all.length - sents.length;
  // Only re-litigate Tier A hits we are not already sure about.
  const candidates = tierA.filter((f) => (f.confidence ?? 1) < adjudicateBelow);

  if (!sents.length && !candidates.length) {
    return { findings: [], suppressed: [], gate: null, severity: null, truncated: 0, degraded: false, error: null, model: config.jev.model };
  }

  const questions = {
    gate: {
      type: 'noul',
      instructions: 'The text reveals something about the organization that is not already public.',
      criteria: {
        true: 'It names an identified person or customer, an internal project, undisclosed financials, a planned change such as redundancies or an acquisition, a security weakness, or a credential.',
        false: 'Routine correspondence or a general request, mentioning people, places or products without revealing anything non-public about them.',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How damaging would it be if this text left the organization unchanged?',
      criteria: [
        'Public or already disclosed; no impact.',
        'Internal but routine; mild embarrassment at worst.',
        'Confidential business information; competitive or contractual harm.',
        'Regulated personal data or material non-public information; legal and regulatory exposure.',
        'Credentials, keys or an unfixed security weakness; immediate operational risk.',
      ],
    },
  };

  /**
   * Two questions per sentence, not one.
   *
   * A single Choice over twelve sensitive classes plus `none` asks the model to
   * find a category, and it obliges: offered twelve plausible options against
   * one escape hatch, benign prompts get labelled. Measured on the corpus that
   * put clean-prompt false positives at 26.7%, against 0% for the generative
   * judge, and it flagged the mosaic control case that scored 10% when asked as
   * a yes/no.
   *
   * So gate first with the criteria that actually tested well, and only let
   * classification run as a second question. Fan-out makes the extra question
   * free.
   */
  sents.forEach((s, i) => {
    questions[`hot_${i}`] = hotQuestion(s);
    questions[`sent_${i}`] = choice(
      s.context
        ? `If that line does reveal something non-public, which kind is it? "${clip(s.text, 120)}" (the text around it, as context only: "${clip(s.context)}")`
        : `If that sentence does reveal something non-public, which kind is it? "${clip(s.text)}"`,
      TAXONOMY,
    );
  });

  candidates.forEach((c, i) => {
    questions[`cand_${i}`] = choice(
      `Substituting the span "${clip(c.text, 120)}" with a placeholder would protect which kind of non-public information? Choose none if replacing it would protect nothing.`,
      TAXONOMY,
    );
  });

  let answers;
  try {
    answers = await ask({ text, questions, signal });
  } catch (err) {
    return {
      findings: [],
      suppressed: [],
      gate: null,
      severity: null,
      truncated,
      degraded: true,
      error: err.message,
      model: config.jev.model,
    };
  }

  const findings = [];
  const suppressed = [];

  // How certain the gate must be before a sentence is treated as sensitive.
  // This is the precision/recall dial: raise it and clean prompts stay clean
  // but leaks slip through; lower it and the reverse. Overridable so the trade
  // can be swept rather than guessed.
  const hotFloor = Number(process.env.DLP_SENTENCE_HOT_ABOVE ?? policy?.thresholds?.sentence_hot_above ?? 0.6);

  sents.forEach((s, i) => {
    // The gate decides whether the sentence is sensitive at all; the Choice
    // only names what kind. Classification never promotes a cold sentence.
    const hot = num(answers[`hot_${i}`]?.noul, 0);
    if (hot < hotFloor) return;

    const a = answers[`sent_${i}`];
    const cls = a?.choice;
    const confidence = Math.min(hot, num(a?.confidence, 0));
    if (!cls || cls === 'none' || !TAXONOMY[cls] || confidence < minConfidence) return;
    findings.push({
      start: s.start,
      end: s.end,
      text: s.text,
      cls,
      detector: 'jev',
      confidence,
      tier: 'B',
      // A fact is not an identifier. Replacing "acquiring Saned" with a
      // placeholder masks the counterparty and leaves the deal in plain sight,
      // so semantic findings must never be pseudonymized - policy escalates them.
      semantic: true,
      rationale: `sentence classified as ${cls}`,
    });
  });

  candidates.forEach((c, i) => {
    const a = answers[`cand_${i}`];
    const cls = a?.choice;
    const confidence = num(a?.confidence, 0);
    if (!cls || cls === 'none') {
      suppressed.push({ ...c, suppressedBy: 'jev', suppressedConfidence: confidence });
      return;
    }
    findings.push({ ...c, cls: TAXONOMY[cls] ? cls : c.cls, confidence, detector: `${c.detector}+jev`, adjudicated: true });
  });

  return {
    findings,
    suppressed,
    gate: num(answers.gate?.noul, null),
    severity: num(answers.severity?.score, null),
    truncated,
    degraded: false,
    error: null,
    model: config.jev.model,
  };
}

async function ask({ text, questions, signal }) {
  if (!config.jev.apiKey) throw new Error('no Jev credential configured (DLP_JUDGE_API_KEY)');

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, config.judge.timeoutMs);
  signal?.addEventListener?.('abort', () => ctrl.abort(), { once: true });

  try {
    const res = await fetch(config.jev.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.jev.apiKey}`,
      },
      body: JSON.stringify({
        model: config.jev.model,
        state: {
          description: 'Text an employee is about to send to an external AI assistant. Judge only from `prompt`.',
          prompt: text,
        },
        questions,
      }),
      signal: ctrl.signal,
    });

    if (timedOut) throw new Error(`Jev timed out after ${config.judge.timeoutMs} ms`);
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Jev HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const body = await res.json();
    const answers = body?.answers ?? body;
    if (!answers || typeof answers !== 'object') throw new Error('Jev returned no answers object');
    return answers;
  } finally {
    clearTimeout(timer);
  }
}

const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ').trim();
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
