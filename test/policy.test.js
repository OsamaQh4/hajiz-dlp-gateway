import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, loadPolicy, getPolicy, watchlistFor, validatePolicy, policyStatus } from '../gateway/policy/policy.js';

loadPolicy();

const finding = (over = {}) => ({
  start: 0,
  end: 5,
  text: 'xxxxx',
  cls: 'email',
  detector: 'email',
  confidence: 0.99,
  tier: 'A',
  ...over,
});

test('the policy file loads and carries the organization watchlist', () => {
  const p = getPolicy();
  assert.ok(p.actions.secret, 'policy must define an action for secrets');
  assert.ok(watchlistFor(null).includes('Project Falcon'));
});

test('the strictest finding decides the request', () => {
  const d = decide([finding(), finding({ cls: 'secret', detector: 'anthropic_key' })]);
  assert.equal(d.action, 'block');
  assert.equal(d.blocked.length, 1);
  assert.ok(d.reasons.some((r) => r.includes('secret')));
});

test('ordinary PII is pseudonymized rather than blocked', () => {
  const d = decide([finding({ cls: 'national_id' })]);
  assert.equal(d.action, 'pseudonymize');
  assert.equal(d.toTokenize.length, 1);
});

test('a low-confidence judge finding goes to a human instead of acting silently', () => {
  const d = decide([finding({ cls: 'person', tier: 'B', confidence: 0.55 })]);
  assert.equal(d.action, 'escalate');
});

test('a confident judge finding is handled without bothering anyone', () => {
  const d = decide([finding({ cls: 'person', tier: 'B', confidence: 0.95 })]);
  assert.equal(d.action, 'pseudonymize');
});

test('an over-broad judge span is escalated rather than substituted', () => {
  // A model that returns a whole sentence instead of the value inside it would,
  // if pseudonymized, leave the prompt with nothing in it.
  const sentence = 'we are acquiring Saned next quarter and it has not been announced yet, '.repeat(3);
  const d = decide([
    finding({ cls: 'project', tier: 'B', confidence: 0.95, start: 0, end: sentence.length, text: sentence }),
  ]);
  assert.equal(d.action, 'escalate');
  assert.ok(d.reasons.some((r) => /too broad to substitute/.test(r)));
});

test('a tight judge span is still substituted normally', () => {
  const d = decide([
    finding({ cls: 'project', tier: 'B', confidence: 0.95, start: 0, end: 14, text: 'Project Falcon' }),
  ]);
  assert.equal(d.action, 'pseudonymize');
});

test('a long Tier A span is not second-guessed', () => {
  // A private key block is legitimately long, and Tier A is deterministic.
  const d = decide([finding({ cls: 'internal_host', tier: 'A', confidence: 1, start: 0, end: 400 })]);
  assert.equal(d.action, 'pseudonymize');
});

test('redact outranks pseudonymize but yields to block', () => {
  // Ordered by how much each protects: a redaction keeps nothing, so it is
  // stricter than a reversible placeholder - but gentler than refusing.
  loadPolicy();
  const p = getPolicy();
  p.actions.credentials = 'redact';

  assert.equal(decide([finding({ cls: 'credentials' }), finding({ cls: 'email' })]).action, 'redact');
  assert.equal(decide([finding({ cls: 'credentials' }), finding({ cls: 'secret' })]).action, 'block');

  p.actions.credentials = 'block';
});

test('a redacted finding is still substituted, not merely counted', () => {
  loadPolicy();
  const p = getPolicy();
  p.actions.credentials = 'redact';

  const d = decide([finding({ cls: 'credentials' })]);
  assert.equal(d.toTokenize.length, 1, 'it must reach the vault to be replaced');
  assert.equal(d.toTokenize[0].action, 'redact');

  p.actions.credentials = 'block';
});

test('group overrides apply', () => {
  const f = [finding({ cls: 'internal_host' })];
  assert.equal(decide(f).action, 'pseudonymize');
  assert.equal(decide(f, { group: 'engineering' }).action, 'allow');
});

test('clean requests are allowed', () => {
  assert.equal(decide([]).action, 'allow');
});

test('a degraded judge is surfaced, not hidden', () => {
  const d = decide([], { judgeDegraded: true });
  assert.ok(d.reasons.some((r) => /judge unavailable/i.test(r)));
});

test('escalated findings are still pseudonymized once approved', () => {
  const d = decide([finding({ cls: 'strategic', tier: 'B', confidence: 0.9 })]);
  assert.equal(d.action, 'escalate');
  assert.equal(d.toTokenize.length, 1, 'approval must not send the raw value');
});

test('an unknown action name is rejected rather than quietly ignored', () => {
  // `redcat` for `redact` falls through to default_action, which is gentler
  // than what the administrator meant to write. Caught by name here rather
  // than discovered later by a leak.
  const problems = validatePolicy({ actions: { credentials: 'redcat', email: 'pseudonymize' } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /credentials.*redcat/);

  assert.deepEqual(validatePolicy({ actions: { credentials: 'redact' } }), []);
});

test('a bad action inside a group override is caught too', () => {
  const problems = validatePolicy({ groups: { legal: { actions: { legal: 'blokc' } } } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /groups\.legal/);
});

test('the gate must be a probability', () => {
  assert.equal(validatePolicy({ thresholds: { sentence_hot_above: 1.4 } }).length, 1);
  assert.equal(validatePolicy({ thresholds: { sentence_hot_above: 0.5 } }).length, 0);
});

test('a broken file on reload keeps the last good policy running', async () => {
  // The failure this prevents: one mistyped word replacing an organization's
  // whole rule set with a four-line built-in fallback, silently, at the moment
  // someone edits policy under pressure.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const file = path.join(os.tmpdir(), `hajiz-policy-${process.pid}.yaml`);
  fs.writeFileSync(file, 'version: 9\nname: good\nactions:\n  email: block\n');
  loadPolicy(file);
  assert.equal(getPolicy().actions.email, 'block');
  assert.equal(getPolicy().name, 'good');

  fs.writeFileSync(file, 'version: 10\nname: broken\nactions:\n  email: redcat\n');
  loadPolicy(file);

  assert.equal(getPolicy().name, 'good', 'the running policy must survive the bad edit');
  assert.equal(getPolicy().actions.email, 'block');
  assert.match(policyStatus().error, /redcat/);
  assert.equal(policyStatus().stale, true, 'and the console must be told it is running stale');

  fs.unlinkSync(file);
  loadPolicy();
});
