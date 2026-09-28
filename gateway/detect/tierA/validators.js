/**
 * Checksum validators. These are what keep Tier A's false-positive rate low:
 * any 10-digit number looks like a national ID, but only ~10% of them carry a
 * valid check digit.
 */

/** Luhn mod-10, used for payment cards and for Saudi ID/Iqama numbers. */
export function luhn(digits) {
  const d = String(digits).replace(/\D/g, '');
  if (d.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Saudi National ID (starts with 1) / Iqama (starts with 2): 10 digits where
 * the tenth is a Luhn check digit over the first nine.
 */
export function saudiId(value) {
  const d = String(value).replace(/\D/g, '');
  if (d.length !== 10) return false;
  if (d[0] !== '1' && d[0] !== '2') return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = d.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === d.charCodeAt(9) - 48;
}

/** ISO 13616 IBAN check: move the first four chars to the end, mod 97 === 1. */
export function iban(value) {
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Shannon entropy in bits per character - the secret-detection heuristic. */
export function entropy(value) {
  const s = String(value);
  if (!s.length) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A high-entropy string is only interesting if it also *looks* like a key:
 * mixed character classes and no dictionary-ish structure. Plain English prose
 * and base64-looking hashes of public data trip naive entropy checks constantly.
 */
export function looksLikeSecret(value) {
  const s = String(value);
  if (s.length < 20) return false;
  const classes =
    Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s)) + Number(/[_\-+/=]/.test(s));
  if (classes < 3) return false;
  // Long runs of letters only are almost always words, not keys.
  if (/^[A-Za-z]+$/.test(s)) return false;
  // Identifiers that merely look random: git SHAs, UUIDs, trace ids. Flagging
  // these is the fastest way to make a DLP tool unusable.
  if (/^[0-9a-f]{7,}$/i.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return false;
  return entropy(s) >= 3.6;
}
