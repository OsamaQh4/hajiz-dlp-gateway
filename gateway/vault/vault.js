import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * The token vault.
 *
 * This is the piece that makes the product different from every "redact it and
 * hope" DLP tool: sensitive spans are replaced with stable, type-preserving
 * placeholders, the model reasons about the placeholders perfectly well, and
 * the real values are swapped back into the answer on the way home. The
 * mapping never leaves the tenant.
 */

const PREFIX_BY_CLASS = {
  person: 'PERSON',
  org: 'ORG',
  project: 'PROJECT',
  national_id: 'ID',
  iban: 'IBAN',
  card: 'CARD',
  email: 'EMAIL',
  phone: 'PHONE',
  secret: 'SECRET',
  credentials: 'CRED',
  internal_host: 'HOST',
  financial: 'AMOUNT',
  strategic: 'TOPIC',
  health: 'HEALTH',
  legal: 'LEGAL',
  source_code: 'CODE',
  vulnerability: 'VULN',
  location: 'PLACE',
  other: 'ITEM',
};

const PREFIXES = [...new Set(Object.values(PREFIX_BY_CLASS))];

/**
 * Models do not always echo a placeholder verbatim - they lowercase it, or
 * render `PERSON_1` as `PERSON 1` inside prose. A missed match is not a data
 * leak, it is the opposite: the employee is shown `person_1` where the real
 * name should be, and the product's whole promise quietly fails.
 *
 * So match loosely, then canonicalize before looking the token up. Because only
 * tokens this session actually minted are ever substituted, a stray "person 1"
 * in someone's own text is left alone.
 */
export const TOKEN_RE = new RegExp(`\\b(?:${PREFIXES.join('|')})[_ ]\\d+\\b`, 'gi');

const canonical = (match) => match.replace(/[_ ]/, '_').toUpperCase();

/** Longest placeholder we could ever emit; bounds the streaming hold-back. */
const MAX_TOKEN_LEN = 40;

export class Vault {
  #sessions = new Map();
  #key;

  constructor({ keyHex = config.vault.keyHex } = {}) {
    this.#key =
      keyHex && /^[0-9a-f]{64}$/i.test(keyHex)
        ? Buffer.from(keyHex, 'hex')
        : crypto.randomBytes(32); // ephemeral: mappings die with the process
    this.ephemeralKey = !(keyHex && /^[0-9a-f]{64}$/i.test(keyHex));
  }

  #session(id) {
    let s = this.#sessions.get(id);
    if (!s) {
      s = { byValue: new Map(), byToken: new Map(), counters: new Map(), createdAt: Date.now() };
      this.#sessions.set(id, s);
    }
    s.touchedAt = Date.now();
    return s;
  }

  /**
   * Mint (or reuse) a placeholder for one value. Reuse is what keeps a
   * conversation coherent: the same customer is PERSON_1 in turn 1 and in
   * turn 9, so the model can still follow who is who.
   */
  tokenFor(sessionId, value, cls) {
    const s = this.#session(sessionId);
    const prefix = PREFIX_BY_CLASS[cls] || 'ITEM';
    const key = `${prefix}:${value}`;
    const existing = s.byValue.get(key);
    if (existing) return existing;

    const n = (s.counters.get(prefix) || 0) + 1;
    s.counters.set(prefix, n);
    const token = `${prefix}_${n}`;
    s.byValue.set(key, token);
    s.byToken.set(token, value);
    return token;
  }

  /**
   * Classes whose values are entities people refer to again by a shorter name.
   * An email address or a card number has no second form; a person does.
   */
  static ALIASABLE = new Set(['person', 'org', 'project', 'location']);

  /** Parts that identify nothing on their own and must never become aliases. */
  static GENERIC_PART = new Set([
    'project', 'the', 'mr', 'mrs', 'ms', 'dr', 'prof', 'inc', 'ltd', 'llc', 'co', 'company',
    'corp', 'group', 'team', 'centre', 'center', 'office', 'department', 'system', 'platform',
  ]);

  /**
   * Shorter forms of a value that would refer to the same entity.
   * "Ahmed Al-Otaibi" -> Ahmed, Al-Otaibi.  "Project Falcon" -> Falcon.
   * Only proper-noun-looking parts qualify, so "the project is late" is safe.
   */
  static aliasesOf(value) {
    const parts = String(value).split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) return [];
    return parts.filter(
      (p) => p.length >= 3 && /^\p{Lu}/u.test(p) && !Vault.GENERIC_PART.has(p.toLowerCase().replace(/[^\p{L}]/gu, '')),
    );
  }

  /**
   * Replace every finding in `text` with a placeholder.
   * @returns {{text:string, mappings:Array<{token:string,cls:string,detector:string,confidence:number,original:string}>}}
   */
  /**
   * An irreversible replacement, for values the model never needs and that must
   * never come back. A pseudonym is restored on the way home; a redaction is
   * not, because restoring a credential into a reply would hand it straight to
   * whoever reads it.
   */
  static redactionFor(cls) {
    return `[REDACTED:${cls}]`;
  }

  tokenize(sessionId, text, findings) {
    const ordered = [...findings].sort((a, b) => b.start - a.start);
    const mappings = [];
    let out = text;
    for (const f of ordered) {
      const original = text.slice(f.start, f.end);
      // A redacted span gets no vault entry at all. Nothing to restore means
      // nothing that can be restored by mistake.
      const redacted = f.action === 'redact';
      const replacement = redacted ? Vault.redactionFor(f.cls) : this.tokenFor(sessionId, original, f.cls);
      out = out.slice(0, f.start) + replacement + out.slice(f.end);
      mappings.unshift({
        token: redacted ? null : replacement,
        redacted,
        cls: f.cls,
        detector: f.detector,
        confidence: f.confidence,
        tier: f.tier,
        original,
        rationale: f.rationale,
      });
    }
    return this.#expandAliases(out, mappings);
  }

  /**
   * Second pass: catch the mentions the first pass could not see.
   *
   * Findings carry exact spans, so substituting "Ahmed Al-Otaibi" left a later
   * bare "Al-Otaibi" untouched and the customer's name went out in the clear.
   * It was invisible for 71 tests because every fixture mentioned a name once.
   *
   * An alias is only substituted when it resolves to exactly one entity. When
   * two people in the same prompt share a surname the alias is genuinely
   * ambiguous, and guessing would merge two identities - so it is reported for
   * a judge to adjudicate rather than silently resolved.
   */
  #expandAliases(text, mappings) {
    const byAlias = new Map();
    for (const m of mappings) {
      if (!Vault.ALIASABLE.has(m.cls)) continue;
      for (const alias of Vault.aliasesOf(m.original)) {
        if (!byAlias.has(alias)) byAlias.set(alias, new Set());
        byAlias.get(alias).add(m.token);
      }
    }

    let out = text;
    const ambiguous = [];
    for (const [alias, tokens] of byAlias) {
      if (tokens.size > 1) {
        ambiguous.push({ alias, candidates: [...tokens] });
        continue;
      }
      const token = [...tokens][0];
      const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(alias)}(?![\\p{L}\\p{N}_-])`, 'gu');
      let replaced = 0;
      out = out.replace(re, () => {
        replaced += 1;
        return token;
      });
      if (replaced) {
        const m = mappings.find((x) => x.token === token);
        if (m) m.aliasesSubstituted = (m.aliasesSubstituted ?? 0) + replaced;
      }
    }

    return { text: out, mappings, ambiguousAliases: ambiguous };
  }

  /**
   * Swap placeholders back to real values in a complete string.
   *
   * `json: true` escapes the replacement, because the text being patched is
   * inside a JSON string literal. A placeholder is always safe characters, but
   * the value behind it may contain a quote, backslash or newline - splicing
   * that in raw would corrupt the document the client is parsing.
   */
  rehydrate(sessionId, text, { json = false } = {}) {
    if (!text) return text;
    const s = this.#sessions.get(sessionId);
    if (!s) return text;
    return text.replace(TOKEN_RE, (tok) => {
      const key = canonical(tok);
      if (!s.byToken.has(key)) return tok;
      const value = s.byToken.get(key);
      return json ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  /** A stateful rehydrator for streamed responses. */
  streamRehydrator(sessionId, opts = {}) {
    return new StreamRehydrator(this, sessionId, opts);
  }

  /**
   * Per-content-block rehydrators for one streamed response.
   *
   * A reply interleaves prose with tool-call arguments, and each content block
   * needs its own hold-back buffer - and its own escaping rule, since tool
   * arguments arrive as fragments of a JSON string while prose does not.
   */
  streamContext(sessionId) {
    return new StreamContext(this, sessionId);
  }

  sweep(now = Date.now()) {
    let dropped = 0;
    for (const [id, s] of this.#sessions) {
      if (now - (s.touchedAt ?? s.createdAt) > config.vault.ttlMs) {
        this.#sessions.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  stats() {
    let tokens = 0;
    for (const s of this.#sessions.values()) tokens += s.byToken.size;
    return { sessions: this.#sessions.size, tokens, ephemeralKey: this.ephemeralKey };
  }

  /** AES-256-GCM. Used for the optional on-disk copy of the mappings. */
  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  decrypt({ iv, tag, data }) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  persist(file = config.vault.file) {
    const dump = [...this.#sessions.entries()].map(([id, s]) => [id, [...s.byToken.entries()]]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.encrypt(JSON.stringify(dump))), 'utf8');
  }
}

/**
 * Streaming rehydration.
 *
 * A placeholder routinely arrives split across two deltas ("PROJ" then
 * "ECT_1"), so we hold back any trailing run that could still grow into a
 * token and release it once we know it cannot.
 */
/**
 * Holds one rehydrator per content block of a streamed reply, so prose and
 * tool-call arguments do not share a hold-back buffer or an escaping rule.
 */
export class StreamContext {
  #byIndex = new Map();

  constructor(vault, sessionId) {
    this.vault = vault;
    this.sessionId = sessionId;
  }

  /** @param {number} index @param {{json?:boolean}} opts */
  for(index, opts = {}) {
    const key = `${index ?? 0}`;
    if (!this.#byIndex.has(key)) {
      this.#byIndex.set(key, new StreamRehydrator(this.vault, this.sessionId, opts));
    }
    return this.#byIndex.get(key);
  }

  /** Release whatever every block is still holding back. */
  flushAll() {
    const out = [];
    for (const [index, r] of this.#byIndex) {
      const tail = r.flush();
      if (tail) out.push({ index: Number(index), text: tail });
    }
    return out;
  }
}

export class StreamRehydrator {
  #buffer = '';

  constructor(vault, sessionId, { json = false } = {}) {
    this.vault = vault;
    this.sessionId = sessionId;
    this.json = json;
  }

  push(chunk) {
    if (!chunk) return '';
    this.#buffer += chunk;
    let cut = this.#buffer.length;
    // Case-insensitive, and allows the space form, to match what rehydrate()
    // accepts - otherwise a lowercase placeholder splits across chunks and
    // escapes the hold-back.
    const m = /[A-Za-z][A-Za-z0-9_]*[_ ]?\d*$/.exec(this.#buffer);
    if (m && this.#buffer.length - m.index <= MAX_TOKEN_LEN) cut = m.index;
    const emit = this.#buffer.slice(0, cut);
    this.#buffer = this.#buffer.slice(cut);
    return this.vault.rehydrate(this.sessionId, emit, { json: this.json });
  }

  flush() {
    const rest = this.#buffer;
    this.#buffer = '';
    return this.vault.rehydrate(this.sessionId, rest, { json: this.json });
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[]\]/g, '\export const vault = new Vault();');

export const vault = new Vault();
