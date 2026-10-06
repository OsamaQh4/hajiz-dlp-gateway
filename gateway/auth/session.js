/*
 * Console sessions.
 *
 * A signed cookie rather than a server-side session table. There is one
 * administrator and one appliance, so a table would buy nothing and cost a
 * restart: an operator signed out every time the gateway is upgraded learns to
 * keep the password somewhere convenient, which is the opposite of the point.
 *
 * The signing key lives in data/ and is generated on first use. If it is
 * deleted every session is invalidated, which is the intended way to force
 * everyone out.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.js';

const KEY_FILE = process.env.DLP_SESSION_KEY_FILE || path.join(ROOT, 'data', 'session.key');
const COOKIE = 'hajiz_session';
const TTL_MS = Number(process.env.DLP_SESSION_TTL_MS || 12 * 60 * 60 * 1000);

let key = null;

function signingKey() {
  if (key) return key;
  try {
    key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (key.length >= 32) return key;
  } catch {
    /* no key yet */
  }
  key = crypto.randomBytes(48);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, `${key.toString('base64')}\n`, { mode: 0o600 });
  return key;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns the payload, or null if the token is forged, tampered or expired. */
export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  const expected = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

export function issue({ username }) {
  const payload = { username, iat: Date.now(), exp: Date.now() + TTL_MS };
  return { token: sign(payload), expiresAt: payload.exp };
}

/**
 * SameSite=Strict because the console has no cross-site use whatsoever, which
 * removes CSRF without a token dance. HttpOnly so a mistake in the console's
 * own JavaScript cannot hand the session to anything. Secure only when the
 * request arrived over TLS - an appliance reached over plain HTTP on an
 * internal network would otherwise set a cookie the browser refuses to send,
 * and the operator would be unable to sign in with no visible reason.
 */
export function cookieHeader(token, { secure, maxAgeMs = TTL_MS } = {}) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader({ secure } = {}) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionFrom(req) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return readToken(rest.join('='));
  }
  return null;
}

export const SESSION_COOKIE = COOKIE;
export const sessionTtlMs = () => TTL_MS;

/**
 * Throw away the signing key and make a new one.
 *
 * Every token ever issued becomes unverifiable, including the one belonging to
 * whoever asked. That is deliberate: this is the control you reach for when you
 * believe a session has been stolen, and one that spared the caller would leave
 * the thief signed in if the thief is the one who pressed it.
 */
export function rotateKey() {
  key = crypto.randomBytes(48);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, `${key.toString('base64')}\n`, { mode: 0o600 });
  return { rotatedAt: new Date().toISOString() };
}
