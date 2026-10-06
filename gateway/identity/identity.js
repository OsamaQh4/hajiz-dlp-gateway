/*
 * Who was at that address.
 *
 * By itself this appliance sees a network address and nothing else. It is a
 * data-loss control, not a directory: it does not know who sent a prompt, and
 * pretending otherwise is the mistake that turns a security tool into a
 * surveillance claim it cannot support. Names appear only when an
 * administrator connects a source that can answer the one question the
 * appliance cannot - who was signed in at this address, at this moment.
 *
 * Four rules are built in rather than left to configuration:
 *
 *   Read-only. The appliance asks; it never writes to the source. A DLP
 *   gateway with write access to the directory is a much larger problem than
 *   the one it was installed to solve.
 *
 *   Never guessed. An address that does not resolve stays an address. A shared
 *   or service machine with nobody signed in must not be attributed to the
 *   last person who used it.
 *
 *   Never backfilled. A record written before the source was connected keeps
 *   the address it was written with. Attaching names retroactively would mean
 *   the audit log said something today that it did not say yesterday, which is
 *   precisely what its hash chain exists to make impossible.
 *
 *   Never load-bearing. If the source stops answering, names disappear and
 *   inspection carries on untouched. Identity decorates the record; it does
 *   not decide anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const FILE = process.env.DLP_IDENTITY_FILE || path.join(ROOT, 'data', 'identity.json');
const TTL_MS = Number(process.env.DLP_IDENTITY_TTL_MS || 60000);

const cache = new Map();
const stats = { lookups: 0, resolved: 0, unresolved: 0, errors: 0, lastError: null, lastSyncAt: null };

let settings = null;

function load() {
  if (settings) return settings;
  try {
    settings = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    settings = { enabled: false, source: 'list', entries: [], broker: { url: '', token: '' } };
  }
  return settings;
}

export function saveSettings(next) {
  const merged = { ...load(), ...next };
  // The token is the one secret here; it is kept but never returned by status.
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  settings = merged;
  cache.clear();
  return { ok: true };
}

export const isEnabled = () => load().enabled === true;

/**
 * Normalise what Node hands us. A dual-stack listener reports IPv4 clients as
 * ::ffff:10.0.0.1, which will not match anything an administrator typed into
 * an address list.
 */
export function normalizeAddress(address) {
  const a = String(address ?? '').trim();
  if (!a) return null;
  if (a.startsWith('::ffff:')) return a.slice(7);
  if (a === '::1') return '127.0.0.1';
  return a;
}

/**
 * Resolve an address to a person.
 *
 * @returns {Promise<{address:string, person:string|null, department:string|null,
 *   source:string|null, resolved:boolean, reason:string|null}>}
 */
export async function resolve(rawAddress) {
  const address = normalizeAddress(rawAddress);
  const miss = (reason) => ({ address, person: null, department: null, source: null, resolved: false, reason });

  if (!address) return miss('no source address');
  if (!isEnabled()) return miss('no identity source is connected');

  const cached = cache.get(address);
  if (cached && cached.expires > Date.now()) return cached.value;

  stats.lookups += 1;
  let value;
  try {
    value = load().source === 'broker' ? await fromBroker(address) : fromList(address);
    stats.lastSyncAt = Date.now();
  } catch (err) {
    // The source being down must not cost the request. Names vanish; the
    // prompt is still inspected, decided and recorded exactly as before.
    stats.errors += 1;
    stats.lastError = err.message;
    return miss(`identity source unavailable: ${err.message}`);
  }

  if (value.resolved) stats.resolved += 1;
  else stats.unresolved += 1;

  cache.set(address, { value, expires: Date.now() + TTL_MS });
  return value;
}

/** A list an administrator uploads: fixed assignments, shared and kiosk machines. */
function fromList(address) {
  const entry = (load().entries ?? []).find((e) => normalizeAddress(e.address) === address);
  if (!entry) {
    return {
      address,
      person: null,
      department: null,
      source: 'list',
      resolved: false,
      reason: 'no entry for this address',
    };
  }
  return {
    address,
    person: entry.person ?? null,
    department: entry.department ?? null,
    source: 'list',
    resolved: Boolean(entry.person),
    reason: entry.person ? null : 'the entry names no person',
  };
}

/**
 * A VDI broker or directory that answers "who holds this address".
 *
 * Deliberately a GET with the address in the path and a short timeout. The
 * lookup sits in the path of a prompt, so a slow directory must become an
 * unresolved name rather than a slow gateway.
 */
async function fromBroker(address) {
  const { url, token } = load().broker ?? {};
  if (!url) throw new Error('no broker URL configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.DLP_IDENTITY_TIMEOUT_MS || 1500));

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(address)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.status === 404) {
      return { address, person: null, department: null, source: 'broker', resolved: false, reason: 'nobody signed in at this address' };
    }
    if (!res.ok) throw new Error(`broker returned ${res.status}`);

    const body = await res.json();
    return {
      address,
      person: body.person ?? body.user ?? null,
      department: body.department ?? body.dept ?? null,
      source: 'broker',
      resolved: Boolean(body.person ?? body.user),
      reason: body.person || body.user ? null : 'the broker named no person',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function identityStatus() {
  const s = load();
  return {
    enabled: s.enabled === true,
    source: s.source ?? 'list',
    entries: (s.entries ?? []).length,
    // The list itself, so the console can edit it rather than overwrite it
    // with a blank field. These are addresses and names an administrator
    // typed in; the broker token is the only secret here and it stays put.
    list: s.entries ?? [],
    // Present, never returned: an administrator needs to know a token is set,
    // not what it is.
    brokerUrl: s.broker?.url || null,
    brokerTokenSet: Boolean(s.broker?.token),
    ttlMs: TTL_MS,
    cached: cache.size,
    ...stats,
    resolutionRate: stats.lookups ? stats.resolved / stats.lookups : null,
  };
}

/** For the console's live preview: resolve without touching the counters. */
export async function preview(address) {
  const before = { ...stats };
  const value = await resolve(address);
  Object.assign(stats, before);
  return value;
}

export const identityFile = () => FILE;
