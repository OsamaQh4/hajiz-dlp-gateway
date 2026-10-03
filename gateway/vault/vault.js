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
   * Replace every finding in `text` with a placeholder.
   * @returns {{text:string, mappings:Array<{token:string,cls:string,detector:string,confidence:number,original:string}>}}
   */
  tokenize(sessionId, text, findings) {
    const ordered = [...findings].sort((a, b) => b.start - a.start);
    const mappings = [];
    let out = text;
    for (const f of ordered) {
      const original = text.slice(f.start, f.end);
      const token = this.tokenFor(sessionId, original, f.cls);
      out = out.slice(0, f.start) + token + out.slice(f.end);
      mappings.unshift({
        token,
        cls: f.cls,
        detector: f.detector,
        confidence: f.confidence,
        tier: f.tier,
        original,
        rationale: f.rationale,
      });
    }
    return { text: out, mappings };
  }

  /** Swap placeholders back to real values in a complete string. */
  rehydrate(sessionId, text) {
    if (!text) return text;
    const s = this.#sessions.get(sessionId);
    if (!s) return text;
    return text.replace(TOKEN_RE, (tok) => {
      const key = canonical(tok);
      return s.byToken.has(key) ? s.byToken.get(key) : tok;
    });
  }

  /** A stateful rehydrator for streamed responses. */
  streamRehydrator(sessionId) {
    return new StreamRehydrator(this, sessionId);
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
export class StreamRehydrator {
  #buffer = '';

  constructor(vault, sessionId) {
    this.vault = vault;
    this.sessionId = sessionId;
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
    return this.vault.rehydrate(this.sessionId, emit);
  }

  flush() {
    const rest = this.#buffer;
    this.#buffer = '';
    return this.vault.rehydrate(this.sessionId, rest);
  }
}

export const vault = new Vault();
