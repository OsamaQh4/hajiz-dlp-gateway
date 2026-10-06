import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Both modules read their paths from the environment at import time, so these
// are set before the dynamic imports below rather than in a beforeEach.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajiz-auth-'));
process.env.DLP_ADMIN_FILE = path.join(dir, 'admin.json');
process.env.DLP_SESSION_KEY_FILE = path.join(dir, 'session.key');
process.env.DLP_ADMIN_MAX_ATTEMPTS = '3';
process.env.DLP_ADMIN_LOCKOUT_MS = '400';

const accounts = await import('../gateway/auth/accounts.js');
const session = await import('../gateway/auth/session.js');

const PASSWORD = 'correct horse battery';

const reset = () => {
  try {
    fs.unlinkSync(process.env.DLP_ADMIN_FILE);
  } catch {
    /* not provisioned */
  }
};

test('an appliance starts with no administrator', () => {
  reset();
  assert.equal(accounts.isProvisioned(), false);
  assert.equal(accounts.accountStatus().provisioned, false);
});

test('provisioning creates the one account and refuses to do it twice', () => {
  reset();
  assert.equal(accounts.provision({ password: PASSWORD }).ok, true);
  assert.equal(accounts.isProvisioned(), true);

  // Provisioning twice would be a way to take the appliance over, not a
  // convenience: the second caller would own the console.
  const second = accounts.provision({ password: 'another long password' });
  assert.equal(second.ok, false);
  assert.match(second.error, /already exists/);
});

test('the password is never stored, and the file is not readable as one', () => {
  reset();
  accounts.provision({ password: PASSWORD });
  const raw = fs.readFileSync(process.env.DLP_ADMIN_FILE, 'utf8');

  assert.ok(!raw.includes(PASSWORD), 'the password must not appear in the file');
  const stored = JSON.parse(raw);
  assert.ok(stored.salt && stored.hash, 'salt and hash are stored');
  assert.ok(stored.params?.N >= 16384, 'the cost parameters are recorded with the hash');
});

test('the same password hashes differently for two accounts', () => {
  reset();
  accounts.provision({ password: PASSWORD });
  const first = JSON.parse(fs.readFileSync(process.env.DLP_ADMIN_FILE, 'utf8'));
  reset();
  accounts.provision({ password: PASSWORD });
  const second = JSON.parse(fs.readFileSync(process.env.DLP_ADMIN_FILE, 'utf8'));

  assert.notEqual(first.salt, second.salt, 'each account gets its own salt');
  assert.notEqual(first.hash, second.hash, 'so identical passwords do not share a hash');
});

test('the right password is accepted and the wrong one is not', () => {
  reset();
  accounts.provision({ password: PASSWORD });

  assert.equal(accounts.verify({ username: 'admin', password: PASSWORD }).ok, true);
  assert.equal(accounts.verify({ username: 'admin', password: 'wrong password here' }).ok, false);
  assert.equal(accounts.verify({ username: 'root', password: PASSWORD }).ok, false);
});

test('repeated failures lock the account, and the lock expires on its own', async () => {
  reset();
  accounts.provision({ password: PASSWORD });

  for (let i = 0; i < 3; i += 1) accounts.verify({ username: 'admin', password: 'nope nope nope' });

  const locked = accounts.verify({ username: 'admin', password: PASSWORD });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked', 'even the correct password is refused while locked');

  // The window is rolling rather than cleared only by a success, so someone
  // guessing forever cannot hold the real administrator out indefinitely.
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(accounts.verify({ username: 'admin', password: PASSWORD }).ok, true);
});

test('a successful sign-in forgets the earlier failures', () => {
  reset();
  accounts.provision({ password: PASSWORD });
  accounts.verify({ username: 'admin', password: 'wrong one' });
  accounts.verify({ username: 'admin', password: 'wrong two' });
  assert.equal(accounts.verify({ username: 'admin', password: PASSWORD }).ok, true);
  assert.equal(accounts.accountStatus().failedAttempts, 0);
});

test('changing the password clears a lockout, and the old one stops working', () => {
  reset();
  accounts.provision({ password: PASSWORD });
  for (let i = 0; i < 3; i += 1) accounts.verify({ username: 'admin', password: 'bad guess here' });
  assert.equal(accounts.accountStatus().locked, true);

  assert.equal(accounts.setPassword('a different long password').ok, true);
  assert.equal(accounts.accountStatus().locked, false);
  assert.equal(accounts.verify({ username: 'admin', password: PASSWORD }).ok, false);
  assert.equal(accounts.verify({ username: 'admin', password: 'a different long password' }).ok, true);
});

test('short passwords are refused', () => {
  reset();
  assert.ok(accounts.passwordProblems('short').length > 0);
  assert.equal(accounts.passwordProblems('a sufficiently long one').length, 0);
});

test('a session token round-trips, and a tampered one does not', () => {
  const { token } = session.issue({ username: 'admin' });
  assert.equal(session.readToken(token).username, 'admin');

  // Flip a character in the payload and the signature stops matching.
  const [body, mac] = token.split('.');
  const flipped = `${body.slice(0, -1)}${body.at(-1) === 'A' ? 'B' : 'A'}.${mac}`;
  assert.equal(session.readToken(flipped), null);

  // A token with no signature at all, and one signed with nothing.
  assert.equal(session.readToken(body), null);
  assert.equal(session.readToken(`${body}.`), null);
  assert.equal(session.readToken('nonsense'), null);
});

test('an expired session is refused', () => {
  const past = Buffer.from(JSON.stringify({ username: 'admin', exp: Date.now() - 1000 })).toString('base64url');
  assert.equal(session.readToken(`${past}.whatever`), null);
});

test('the cookie cannot be read by script and is not sent cross-site', () => {
  const header = session.cookieHeader('abc', { secure: true });
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);

  // Over plain HTTP on an internal network, Secure would make the browser
  // refuse to send the cookie and sign-in would fail with nothing to see.
  assert.ok(!session.cookieHeader('abc', { secure: false }).includes('Secure'));
});

test('the session is read from the cookie header, and absent means absent', () => {
  const { token } = session.issue({ username: 'admin' });
  assert.equal(session.sessionFrom({ headers: { cookie: `hajiz_session=${token}` } })?.username, 'admin');
  assert.equal(session.sessionFrom({ headers: { cookie: `other=1; hajiz_session=${token}` } })?.username, 'admin');
  assert.equal(session.sessionFrom({ headers: {} }), null);
  assert.equal(session.sessionFrom({ headers: { cookie: 'hajiz_session=forged' } }), null);
});
