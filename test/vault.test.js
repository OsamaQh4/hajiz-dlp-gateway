import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../gateway/vault/vault.js';
import { scanTierA } from '../gateway/detect/tierA/index.js';

const findingsFor = (text, watchlist = []) => scanTierA(text, { watchlist });

test('tokenize replaces every finding and rehydrate restores the original exactly', () => {
  const vault = new Vault();
  const text = 'Ahmed (1098765439) emailed a@b.sa about Project Falcon.';
  const findings = findingsFor(text, ['Project Falcon']);

  const { text: sanitized, mappings } = vault.tokenize('s1', text, findings);

  assert.ok(!sanitized.includes('1098765439'));
  assert.ok(!sanitized.includes('a@b.sa'));
  assert.ok(!sanitized.includes('Project Falcon'));
  assert.equal(mappings.length, findings.length);
  assert.equal(vault.rehydrate('s1', sanitized), text);
});

test('the same value gets the same placeholder across turns, so the model can follow it', () => {
  const vault = new Vault();
  const a = vault.tokenize('s1', 'Contact a@b.sa', findingsFor('Contact a@b.sa'));
  const b = vault.tokenize('s1', 'Resend to a@b.sa', findingsFor('Resend to a@b.sa'));
  assert.equal(a.mappings[0].token, b.mappings[0].token);
});

test('sessions are isolated - one tenant cannot rehydrate another tenant placeholders', () => {
  const vault = new Vault();
  const { text: sanitized } = vault.tokenize('alice', 'mail a@b.sa', findingsFor('mail a@b.sa'));
  assert.equal(vault.rehydrate('bob', sanitized), sanitized);
  assert.equal(vault.rehydrate('alice', sanitized), 'mail a@b.sa');
});

test('placeholders keep their type, so the prompt still makes sense', () => {
  const vault = new Vault();
  const text = 'Ahmed 1098765439 paid with 4111111111111111 from SA0380000000608010167519';
  const { text: sanitized } = vault.tokenize('s1', text, findingsFor(text));
  assert.match(sanitized, /ID_\d+/);
  assert.match(sanitized, /CARD_\d+/);
  assert.match(sanitized, /IBAN_\d+/);
});

test('streaming rehydration works when a placeholder is split across chunks', () => {
  const vault = new Vault();
  const text = 'Write to a@b.sa about it';
  const { text: sanitized } = vault.tokenize('s1', text, findingsFor(text));
  const token = sanitized.match(/EMAIL_\d+/)[0];

  const stream = vault.streamRehydrator('s1');
  let out = '';
  // Deliberately split mid-placeholder, one character at a time.
  for (const ch of `Sure - I emailed ${token} just now.`) out += stream.push(ch);
  out += stream.flush();

  assert.equal(out, 'Sure - I emailed a@b.sa just now.');
});

test('streaming rehydration never emits a partial placeholder', () => {
  const vault = new Vault();
  const text = 'Write to a@b.sa';
  const { text: sanitized } = vault.tokenize('s1', text, findingsFor(text));
  const token = sanitized.match(/EMAIL_\d+/)[0];

  const stream = vault.streamRehydrator('s1');
  const first = stream.push(`ping ${token.slice(0, 3)}`);
  assert.ok(!first.includes(token.slice(0, 3)), 'the partial token must be held back');
  const rest = stream.push(`${token.slice(3)} done`) + stream.flush();
  assert.equal(first + rest, 'ping a@b.sa done');
});

test('unknown placeholders pass through untouched', () => {
  const vault = new Vault();
  assert.equal(vault.rehydrate('s1', 'see PERSON_9 and ORG_4'), 'see PERSON_9 and ORG_4');
});

test('a second mention of the same person does not escape', () => {
  // The defect: findings carry exact spans, so "Ahmed Al-Otaibi" was
  // substituted and a later bare "Al-Otaibi" went out in the clear. Invisible
  // for 71 tests because every fixture mentioned a name exactly once.
  const vault = new Vault();
  const text = 'Ahmed Al-Otaibi reported it. Al-Otaibi says it began today, and Ahmed is waiting.';
  const findings = [{ start: 0, end: 15, cls: 'person', detector: 'judge', confidence: 0.95, tier: 'B' }];

  const { text: out, mappings } = vault.tokenize('s1', text, findings);
  assert.ok(!/Al-Otaibi/.test(out), 'the surname must not survive');
  assert.ok(!/\bAhmed\b/.test(out), 'the given name must not survive');
  assert.equal(mappings[0].aliasesSubstituted, 2);
});

test('a generic part of a name never becomes an alias', () => {
  const vault = new Vault();
  const text = 'Project Falcon is late. The project is late because the team is small.';
  const findings = [{ start: 0, end: 14, cls: 'project', detector: 'watchlist', confidence: 1, tier: 'A' }];

  const { text: out } = vault.tokenize('s1', text, findings);
  assert.match(out, /The project is late/, 'the common word must be left alone');
  assert.ok(!/Falcon/.test(out));
});

test('an ambiguous alias is reported rather than guessed', () => {
  // Two people, one surname. Substituting would merge two identities, which is
  // a different kind of wrong from leaking - so it is handed on, not resolved.
  const vault = new Vault();
  const text = 'Ahmed Al-Otaibi and Sara Al-Otaibi met. Al-Otaibi signed the form.';
  const findings = [
    { start: 0, end: 15, cls: 'person', detector: 'judge', confidence: 0.95, tier: 'B' },
    { start: 20, end: 34, cls: 'person', detector: 'judge', confidence: 0.95, tier: 'B' },
  ];

  const { text: out, ambiguousAliases } = vault.tokenize('s1', text, findings);
  assert.match(out, /Al-Otaibi signed/, 'the ambiguous mention is left in place');
  const surname = ambiguousAliases.find((a) => a.alias === 'Al-Otaibi');
  assert.ok(surname, 'the ambiguity must be reported');
  assert.equal(surname.candidates.length, 2);
});

test('atomic values are not aliased', () => {
  // An email address has no shorter form; splitting one would be nonsense.
  const vault = new Vault();
  const text = 'Write to a.alotaibi@example.com.sa about it.';
  const { text: out, mappings } = vault.tokenize('s1', text, findingsFor(text));
  assert.equal(mappings[0].aliasesSubstituted, undefined);
  assert.match(out, /EMAIL_\d+/);
});

test('alias expansion does not disturb placeholders already in place', () => {
  const vault = new Vault();
  const text = 'Ahmed Al-Otaibi emailed a@b.sa. Al-Otaibi called too.';
  const findings = [
    { start: 0, end: 15, cls: 'person', detector: 'judge', confidence: 0.95, tier: 'B' },
    ...findingsFor(text).filter((f) => f.cls === 'email'),
  ];

  const { text: out } = vault.tokenize('s1', text, findings);
  assert.match(out, /EMAIL_\d+/, 'the email placeholder survives the second pass');
  assert.ok(!/Al-Otaibi/.test(out));
  assert.equal((out.match(/PERSON_1/g) ?? []).length, 2);
});

test('a placeholder the model reformatted is still restored', () => {
  // Models do not always echo a placeholder verbatim. A missed match is not a
  // leak - it is worse in a different way: the employee is shown `person_1`
  // where the real name belongs, and the product silently fails its promise.
  const vault = new Vault();
  const findings = findingsFor('mail a@b.sa');
  const { text: sanitized } = vault.tokenize('s1', 'mail a@b.sa', findings);
  const token = sanitized.match(/EMAIL_\d+/)[0];

  for (const variant of [token, token.toLowerCase(), token.replace('_', ' '), token.replace(/^(\w)(\w+)/, (m, a, b) => a + b.toLowerCase())]) {
    assert.equal(
      vault.rehydrate('s1', `sent to ${variant} now`),
      'sent to a@b.sa now',
      `failed to restore the variant ${variant}`,
    );
  }
});

test('a placeholder we never minted is left alone, whatever its case', () => {
  const vault = new Vault();
  vault.tokenize('s1', 'mail a@b.sa', findingsFor('mail a@b.sa'));
  assert.equal(vault.rehydrate('s1', 'see PERSON_9 and person 4'), 'see PERSON_9 and person 4');
});

test('streaming restores a lowercase placeholder split across chunks', () => {
  const vault = new Vault();
  const findings = findingsFor('mail a@b.sa');
  const { text: sanitized } = vault.tokenize('s1', 'mail a@b.sa', findings);
  const token = sanitized.match(/EMAIL_\d+/)[0].toLowerCase();

  const stream = vault.streamRehydrator('s1');
  let out = '';
  for (const ch of `ping ${token} done`) out += stream.push(ch);
  out += stream.flush();
  assert.equal(out, 'ping a@b.sa done');
});

test('vault mappings encrypt and decrypt with AES-256-GCM', () => {
  const key = '11'.repeat(32);
  const vault = new Vault({ keyHex: key });
  const blob = vault.encrypt('PERSON_1 -> Ahmed Al-Otaibi');
  assert.ok(blob.iv && blob.tag && blob.data);
  assert.ok(!JSON.stringify(blob).includes('Ahmed'));
  assert.equal(vault.decrypt(blob), 'PERSON_1 -> Ahmed Al-Otaibi');
});

test('tampered ciphertext fails the auth tag rather than decrypting', () => {
  const vault = new Vault({ keyHex: '22'.repeat(32) });
  const blob = vault.encrypt('secret mapping');
  const flipped = Buffer.from(blob.data, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => vault.decrypt({ ...blob, data: flipped.toString('base64') }));
});

test('expired sessions are swept', () => {
  const vault = new Vault();
  vault.tokenize('s1', 'mail a@b.sa', findingsFor('mail a@b.sa'));
  assert.equal(vault.stats().sessions, 1);
  assert.equal(vault.sweep(Date.now() + 100 * 24 * 60 * 60 * 1000), 1);
  assert.equal(vault.stats().sessions, 0);
});
