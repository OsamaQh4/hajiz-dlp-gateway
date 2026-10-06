/*
 * The local administrator account.
 *
 * This is an appliance, not a service: there is exactly one account, it is
 * created when the gateway first starts, there is no sign-up, and there is no
 * reset by email because the appliance has no business sending mail. A lost
 * password is recovered from a shell on the box, which is the same trust
 * boundary as the policy file itself.
 *
 * Passwords are stored as scrypt hashes with a per-account salt. scrypt rather
 * than a plain digest because the threat here is someone who has taken a copy
 * of data/ and is grinding it offline, and memory-hardness is what makes that
 * expensive. The parameters are recorded alongside the hash so they can be
 * raised later without invalidating existing accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.js';

const FILE = process.env.DLP_ADMIN_FILE || path.join(ROOT, 'data', 'admin.json');

// Cost parameters. N=2^15 keeps a single verification around a tenth of a
// second on the hardware an appliance like this runs on - slow enough to make
// offline grinding costly, fast enough that a reviewer signing in does not
// notice. maxmem has to be raised to match: node's default is below what these
// parameters need and scrypt throws rather than silently weakening itself.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

const LOCKOUT = {
  attempts: Number(process.env.DLP_ADMIN_MAX_ATTEMPTS || 5),
  windowMs: Number(process.env.DLP_ADMIN_LOCKOUT_MS || 15 * 60 * 1000),
};

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

function write(account) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 0600: the hash is not a password, but it is the thing an attacker would
  // grind, so it does not need to be world-readable on a shared box.
  fs.writeFileSync(FILE, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
}

function hash(password, salt, params = PARAMS) {
  return crypto.scryptSync(password, salt, params.keylen, params).toString('base64');
}

/** True when the appliance has an administrator and is ready to be signed into. */
export function isProvisioned() {
  return Boolean(read()?.hash);
}

export function accountStatus() {
  const a = read();
  if (!a) return { provisioned: false };
  const lock = lockState(a);
  return {
    provisioned: true,
    username: a.username,
    createdAt: a.createdAt ?? null,
    passwordChangedAt: a.passwordChangedAt ?? null,
    lastSignInAt: a.lastSignInAt ?? null,
    failedAttempts: a.failed?.length ?? 0,
    maxAttempts: LOCKOUT.attempts,
    lockoutMs: LOCKOUT.windowMs,
    lockedUntil: lock.lockedUntil,
    locked: lock.locked,
  };
}

/**
 * Create the administrator. Refuses if one already exists: provisioning twice
 * would be a way to take the appliance over, not a convenience.
 */
export function provision({ username = 'admin', password }) {
  if (isProvisioned()) return { ok: false, error: 'an administrator already exists' };
  const problems = passwordProblems(password);
  if (problems.length) return { ok: false, error: problems.join('; ') };

  const salt = crypto.randomBytes(16).toString('base64');
  write({
    username,
    salt,
    params: PARAMS,
    hash: hash(password, salt),
    createdAt: new Date().toISOString(),
    passwordChangedAt: new Date().toISOString(),
    lastSignInAt: null,
    failed: [],
  });
  return { ok: true, username };
}

/** Replace the password. Used by the shell tool and by the console. */
export function setPassword(password) {
  const a = read();
  if (!a) return { ok: false, error: 'no administrator exists yet' };
  const problems = passwordProblems(password);
  if (problems.length) return { ok: false, error: problems.join('; ') };

  const salt = crypto.randomBytes(16).toString('base64');
  write({
    ...a,
    salt,
    params: PARAMS,
    hash: hash(password, salt),
    passwordChangedAt: new Date().toISOString(),
    // A password change clears the lockout: the thing being protected against
    // is guessing the old one, and it no longer exists.
    failed: [],
  });
  return { ok: true };
}

function lockState(account) {
  const failed = (account.failed ?? []).filter((t) => Date.now() - t < LOCKOUT.windowMs);
  if (failed.length < LOCKOUT.attempts) return { locked: false, lockedUntil: null, recent: failed };
  const lockedUntil = Math.max(...failed) + LOCKOUT.windowMs;
  return { locked: Date.now() < lockedUntil, lockedUntil, recent: failed };
}

/**
 * Check a password.
 *
 * Failures are counted in a rolling window rather than until a successful
 * sign-in, so an attacker cannot hold the real administrator out indefinitely
 * by guessing forever - the lock expires on its own.
 */
export function verify({ username, password }) {
  const a = read();
  if (!a) return { ok: false, reason: 'not_provisioned' };

  const lock = lockState(a);
  if (lock.locked) {
    return { ok: false, reason: 'locked', lockedUntil: lock.lockedUntil };
  }

  const expected = Buffer.from(a.hash, 'base64');
  const actual = Buffer.from(hash(String(password ?? ''), a.salt, a.params ?? PARAMS), 'base64');
  // Constant time, and the username is compared the same way. Whether the
  // username was right is not information worth leaking on an appliance with
  // exactly one account.
  const sameUser = safeEqual(Buffer.from(String(username ?? '')), Buffer.from(a.username));
  const samePass = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!sameUser || !samePass) {
    write({ ...a, failed: [...lock.recent, Date.now()] });
    const after = lockState(read());
    return {
      ok: false,
      reason: 'bad_credentials',
      remaining: Math.max(0, LOCKOUT.attempts - after.recent.length),
      lockedUntil: after.locked ? after.lockedUntil : null,
    };
  }

  write({ ...a, failed: [], lastSignInAt: new Date().toISOString() });
  return { ok: true, username: a.username };
}

function safeEqual(a, b) {
  if (a.length !== b.length) {
    // Still do the comparison, against a value of matching length, so the
    // early return does not become a length oracle.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Forget the failed attempts without touching the password. The lock exists to
 * slow someone guessing; an administrator standing at the appliance's shell has
 * already demonstrated they are not that person.
 */
export function clearLockout() {
  const a = read();
  if (!a) return { ok: false, error: 'no administrator exists yet' };
  write({ ...a, failed: [] });
  return { ok: true };
}

/**
 * Minimum requirements, deliberately short. Length is the property that
 * matters against offline grinding; rules about punctuation mostly teach
 * people to write Password1! and are not worth the friction here.
 */
export function passwordProblems(password) {
  const p = String(password ?? '');
  const problems = [];
  if (p.length < 12) problems.push('a password must be at least 12 characters');
  if (/^\s|\s$/.test(p)) problems.push('a password must not start or end with a space');
  if (/^(password|admin|hajiz)/i.test(p)) problems.push('a password must not begin with an obvious word');
  return problems;
}

export const accountFile = () => FILE;
