import { luhn, saudiId, iban, looksLikeSecret } from './validators.js';

/**
 * Tier A: deterministic detectors. Sub-millisecond, no model call, and they
 * carry the great majority of real traffic. Each entry is
 *   { id, cls, confidence, regex, group?, validate?, priority }
 * `cls` is the policy class the finding maps to; `priority` breaks ties when
 * two detectors claim overlapping spans (higher wins).
 */
export const detectors = [
  {
    id: 'private_key',
    cls: 'secret',
    confidence: 1,
    priority: 100,
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'anthropic_key',
    cls: 'secret',
    confidence: 1,
    priority: 95,
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'openai_key',
    cls: 'secret',
    confidence: 1,
    priority: 95,
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'aws_access_key',
    cls: 'secret',
    confidence: 1,
    priority: 95,
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github_token',
    cls: 'secret',
    confidence: 1,
    priority: 95,
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: 'google_api_key',
    cls: 'secret',
    confidence: 1,
    priority: 95,
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack_token',
    cls: 'secret',
    confidence: 1,
    priority: 95,
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'jwt',
    cls: 'secret',
    confidence: 0.9,
    priority: 90,
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'connection_string',
    cls: 'credentials',
    confidence: 1,
    priority: 92,
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  },
  {
    id: 'password_assignment',
    cls: 'credentials',
    confidence: 0.85,
    priority: 80,
    // e.g.  password: hunter2   PASSWORD="s3cr3t"   the root password is Ops#2026
    regex: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*(?:[:=]|\bis\b)\s*["'`]?([^\s"'`,;)}\]]{6,})["'`]?/gi,
    group: 1,
    validate: (v) =>
      // Without this, "the token is invalid" reads as a leaked credential.
      /[\d!@#$%^&*_+\-=]/.test(v) &&
      !/^(?:invalid|expired|missing|required|correct|incorrect|unknown|undefined|rejected)$/i.test(v) &&
      // Code that *reads* a credential is not a credential. `apiKey:
      // process.env.DLP_JUDGE_API_KEY` is correct practice, and flagging it
      // makes the tool unusable on any real repository.
      !/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(v) &&
      !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) &&
      !/^(?:\$\{|<|\{\{|%)/.test(v),
  },
  {
    id: 'saudi_national_id',
    cls: 'national_id',
    confidence: 0.97,
    priority: 70,
    regex: /\b[12]\d{9}\b/g,
    validate: saudiId,
  },
  {
    id: 'iban',
    cls: 'iban',
    confidence: 0.98,
    priority: 70,
    // The inner class allows whitespace because an IBAN is usually written in
    // groups of four. It must not END on whitespace, though: `\b` is satisfied
    // between a trailing space and the next word, so the match used to swallow
    // the separator and the placeholder came out glued to the following word -
    // "IBAN SA03…7519 and mobile" was forwarded as "IBAN IBAN_1and mobile".
    // Harmless on the way back, since rehydration restores the span exactly,
    // but the model reads the mangled version. Forcing an alphanumeric last
    // character keeps the same 11-32 length range.
    regex: /\b[A-Z]{2}\d{2}[\sA-Z0-9]{10,31}[A-Z0-9]\b/g,
    validate: iban,
    // The match may run on into following capitals; retract to the last
    // whitespace boundary rather than discarding it, which would leak.
    retract: true,
  },
  {
    id: 'payment_card',
    cls: 'card',
    confidence: 0.95,
    priority: 70,
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (v) => {
      const d = v.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  {
    id: 'email',
    cls: 'email',
    confidence: 0.99,
    priority: 60,
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // Role addresses identify a mailbox, not a person, and appear constantly in
    // code, licences and generated commit trailers.
    validate: (v) => !/^(?:no-?reply|do-?not-?reply|postmaster|abuse|mailer-daemon)@/i.test(v),
  },
  {
    id: 'saudi_phone',
    cls: 'phone',
    confidence: 0.9,
    priority: 55,
    regex: /(?:\+966|00966|\b0)5\d{8}\b/g,
  },
  {
    id: 'intl_phone',
    cls: 'phone',
    confidence: 0.75,
    priority: 50,
    regex: /\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
  },
  {
    id: 'private_ip',
    cls: 'internal_host',
    confidence: 0.8,
    priority: 45,
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'internal_hostname',
    cls: 'internal_host',
    confidence: 0.85,
    priority: 45,
    // The trailing group is an optional real TLD, so exclude file extensions -
    // otherwise `settings.local.json` reads as a host on the .local domain,
    // which happens constantly in source code.
    regex: /\b[a-z0-9][a-z0-9-]{1,40}\.(?:corp|internal|intranet|local|lan|prod|dmz)(?!\.(?:json|jsonc|js|mjs|cjs|ts|tsx|yml|yaml|toml|ini|conf|config|lock|log|md|txt|xml|env|bak|tmp|sh|ps1)\b)(?:\.[a-z]{2,})?\b/gi,
  },
  {
    id: 'high_entropy_secret',
    cls: 'secret',
    confidence: 0.6,
    priority: 30,
    // The lookbehinds exclude strings that are random by design but public:
    // inline data URIs (embedded images, fonts) and subresource/lockfile
    // integrity digests, which fill every package-lock.json.
    regex: /\b(?<!base64,)[A-Za-z0-9_\-+/=]{24,}\b/g,
    // A digest prefix is part of the matched token (`-` is in the character
    // class), so this has to be checked on the value rather than by lookbehind.
    validate: (v) => !/^(?:sha1|sha256|sha384|sha512|md5)-/i.test(v) && looksLikeSecret(v),
  },
];

/**
 * The organization's own watchlist - project codenames, client names, internal
 * system names. Deterministic, and the cheapest way to cover the terms an
 * off-the-shelf detector can never know about.
 */
export function watchlistDetector(terms) {
  const cleaned = (terms || []).filter((t) => typeof t === 'string' && t.trim().length > 1);
  if (!cleaned.length) return null;
  const escaped = cleaned
    .map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  return {
    id: 'watchlist',
    cls: 'project',
    confidence: 1,
    priority: 85,
    regex: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu'),
  };
}
