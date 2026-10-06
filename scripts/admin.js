#!/usr/bin/env node
/*
 * Administrator account management, from a shell on the appliance.
 *
 * This is the recovery path, and it is deliberately the only one. There is no
 * reset by email because the appliance has no business sending mail, and no
 * recovery question because that is a second, weaker password. Someone with a
 * shell here can already read the policy file and the audit log, so letting
 * them set the console password grants nothing they did not have.
 *
 *   node scripts/admin.js status
 *   node scripts/admin.js set-password
 *   node scripts/admin.js set-password --password '…'   (for provisioning scripts)
 *   node scripts/admin.js unlock
 */

import readline from 'node:readline';
import { Writable } from 'node:stream';
import * as accounts from '../gateway/auth/accounts.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : rest[i + 1];
};

/** Read a password without echoing it, so it does not end up in a scrollback. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    process.stdout.write(prompt);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function setPassword() {
  // A password passed as an argument is visible in the process list and the
  // shell history, so it is accepted only for unattended provisioning and
  // called out as the weaker option.
  const given = flag('password');
  if (given) {
    const result = accounts.isProvisioned()
      ? accounts.setPassword(given)
      : accounts.provision({ username: flag('username') || 'admin', password: given });
    if (!result.ok) fail(result.error);
    console.log('  Password set. Note that it was visible in this shell\'s history.');
    return;
  }

  const first = await askHidden('  New password: ');
  const problems = accounts.passwordProblems(first);
  if (problems.length) fail(problems.join('\n  '));

  const again = await askHidden('  Repeat it:    ');
  if (first !== again) fail('the two did not match');

  const result = accounts.isProvisioned()
    ? accounts.setPassword(first)
    : accounts.provision({ username: flag('username') || 'admin', password: first });
  if (!result.ok) fail(result.error);

  console.log('  Password set. Existing console sessions stay valid; delete data/session.key to end them.');
}

function status() {
  const a = accounts.accountStatus();
  if (!a.provisioned) {
    console.log('  No administrator yet. The console asks for one on first visit,');
    console.log('  or run: node scripts/admin.js set-password');
    return;
  }
  console.log(`  username        ${a.username}`);
  console.log(`  created         ${a.createdAt ?? '—'}`);
  console.log(`  password set    ${a.passwordChangedAt ?? '—'}`);
  console.log(`  last sign-in    ${a.lastSignInAt ?? 'never'}`);
  console.log(`  failed attempts ${a.failedAttempts} of ${a.maxAttempts}`);
  console.log(`  locked          ${a.locked ? `yes, until ${new Date(a.lockedUntil).toISOString()}` : 'no'}`);
  console.log(`  file            ${accounts.accountFile()}`);
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

console.log('');
switch (command) {
  case 'status':
    status();
    break;
  case 'set-password':
  case 'reset-password':
    await setPassword();
    break;
  case 'unlock': {
    // Clearing the counter without changing the password: the lock exists to
    // slow guessing, and an administrator at the console has already proven
    // they are not the one guessing.
    const a = accounts.accountStatus();
    if (!a.provisioned) fail('no administrator exists yet');
    accounts.clearLockout();
    console.log('  Lockout cleared.');
    break;
  }
  default:
    console.log('  usage: node scripts/admin.js <status|set-password|unlock>');
    process.exitCode = command ? 1 : 0;
}
console.log('');
