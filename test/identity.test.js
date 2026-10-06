import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The four rules this module exists to keep. Each one is a way the feature
 * could be built that would look identical in a demo and be wrong in use.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajiz-identity-'));
process.env.DLP_IDENTITY_FILE = path.join(dir, 'identity.json');
process.env.DLP_IDENTITY_TTL_MS = '50';

const identity = await import('../gateway/identity/identity.js');
const { summarize } = await import('../gateway/audit/audit.js');

const configure = (settings) => identity.saveSettings(settings);

const LIST = [
  { address: '10.20.31.47', person: 'Noura Al-Harbi', department: 'Finance' },
  { address: '10.20.44.12', person: 'Khalid Al-Otaibi', department: 'Legal' },
  { address: '10.20.12.9', person: null, department: 'Shared' },
];

test('with no source connected, an address stays an address', async () => {
  configure({ enabled: false, source: 'list', entries: LIST });
  const r = await identity.resolve('10.20.31.47');

  assert.equal(r.resolved, false);
  assert.equal(r.person, null);
  assert.equal(r.address, '10.20.31.47');
  assert.match(r.reason, /no identity source/);
});

test('a connected list resolves the addresses it knows', async () => {
  configure({ enabled: true, source: 'list', entries: LIST });
  const r = await identity.resolve('10.20.31.47');

  assert.equal(r.resolved, true);
  assert.equal(r.person, 'Noura Al-Harbi');
  assert.equal(r.department, 'Finance');
});

test('an address with nobody signed in is never guessed at', async () => {
  // A shared or service machine. Attributing its prompts to the last person
  // who used it would be inventing evidence.
  configure({ enabled: true, source: 'list', entries: LIST });

  const shared = await identity.resolve('10.20.12.9');
  assert.equal(shared.resolved, false);
  assert.equal(shared.person, null);

  const unknown = await identity.resolve('10.20.99.99');
  assert.equal(unknown.resolved, false);
  assert.equal(unknown.person, null);
  assert.match(unknown.reason, /no entry/);
});

test('IPv4 addresses seen through a dual-stack listener still match', async () => {
  // Node reports them as ::ffff:10.20.31.47, which matches nothing an
  // administrator would type into a list.
  configure({ enabled: true, source: 'list', entries: LIST });
  assert.equal((await identity.resolve('::ffff:10.20.31.47')).person, 'Noura Al-Harbi');
  assert.equal(identity.normalizeAddress('::1'), '127.0.0.1');
});

test('a source that is down costs a name, not a request', async () => {
  // The failure mode that matters: inspection must continue untouched.
  configure({ enabled: true, source: 'broker', broker: { url: 'http://127.0.0.1:1/nope', token: '' } });

  const r = await identity.resolve('10.20.31.47');
  assert.equal(r.resolved, false);
  assert.equal(r.person, null);
  assert.match(r.reason, /unavailable/);
  assert.equal(r.address, '10.20.31.47', 'the address survives even when the lookup does not');
});

test('the audit record carries the name only when it was known at the time', () => {
  const decision = { perFinding: [], reasons: [] };
  const timings = { tierAMs: 1, tierBMs: null, tierBRan: false };

  const resolved = summarize({
    requestId: 'r1', sessionId: 'anon', group: null, route: '/v1/messages',
    action: 'allow', decision, timings, judge: null,
    identity: { address: '10.20.31.47', person: 'Noura Al-Harbi', department: 'Finance', resolved: true },
  });
  assert.equal(resolved.person, 'Noura Al-Harbi');
  assert.equal(resolved.sourceAddress, '10.20.31.47');

  // Unresolved: the address is recorded, the name is not invented.
  const unresolved = summarize({
    requestId: 'r2', sessionId: 'anon', group: null, route: '/v1/messages',
    action: 'allow', decision, timings, judge: null,
    identity: { address: '10.20.12.9', person: null, department: 'Shared', resolved: false },
  });
  assert.equal(unresolved.person, null);
  assert.equal(unresolved.department, null, 'a department without a person is not attributed either');
  assert.equal(unresolved.sourceAddress, '10.20.12.9');

  // No source at all: both null, and nothing to backfill later.
  const none = summarize({
    requestId: 'r3', sessionId: 'anon', group: null, route: '/v1/messages',
    action: 'allow', decision, timings, judge: null, identity: null,
  });
  assert.equal(none.person, null);
  assert.equal(none.sourceAddress, null);
});

test('the token is kept but never reported', async () => {
  configure({ enabled: true, source: 'broker', broker: { url: 'https://vdi.corp.internal/odata', token: 'secret-token-value' } });
  const status = identity.identityStatus();

  assert.equal(status.brokerTokenSet, true);
  assert.ok(!JSON.stringify(status).includes('secret-token-value'), 'the token must not leave in a status payload');
  assert.equal(status.brokerUrl, 'https://vdi.corp.internal/odata');
});

test('results are cached, and the cache expires', async () => {
  configure({ enabled: true, source: 'list', entries: LIST });
  await identity.resolve('10.20.44.12');
  const first = identity.identityStatus().lookups;

  await identity.resolve('10.20.44.12');
  assert.equal(identity.identityStatus().lookups, first, 'a cached address does not look up again');

  await new Promise((r) => setTimeout(r, 70));
  await identity.resolve('10.20.44.12');
  assert.equal(identity.identityStatus().lookups, first + 1, 'and it does once the entry expires');
});

test('changing the settings clears the cache', async () => {
  configure({ enabled: true, source: 'list', entries: LIST });
  assert.equal((await identity.resolve('10.20.31.47')).person, 'Noura Al-Harbi');

  configure({ enabled: true, source: 'list', entries: [{ address: '10.20.31.47', person: 'Someone Else', department: 'IT' }] });
  assert.equal((await identity.resolve('10.20.31.47')).person, 'Someone Else');
});
