import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { setScalar, setList, applyEdits, findKey } from '../gateway/policy/edit.js';

/**
 * These tests exist because the alternative implementation - load, mutate,
 * dump - passes a "does the value change" test perfectly while destroying the
 * file. So most of what is asserted here is about what must *not* change.
 */

const SAMPLE = `# Hajiz DLP gateway - organization policy.
# Edited by the security team, hot-reloaded by the gateway.

version: 1
name: Default enterprise policy

# On \`redact\` versus \`block\` for credentials. Blocking is the stronger signal
# when someone has just typed a secret.
actions:
  secret: block
  credentials: redact
  email: pseudonymize   # trailing note
  health: escalate

default_action: pseudonymize

thresholds:
  # The gate: swept, not guessed.
  sentence_hot_above: 0.5
  judge_min_confidence: 0.5

escalation:
  wait_for_human_ms: 90000
  auto_decisions_before_block: 3

watchlist:
  - Project Falcon
  - Saned

groups:
  engineering:
    actions:
      source_code: pseudonymize
`;

test('a changed action keeps every comment in the file', () => {
  const out = setScalar(SAMPLE, ['actions', 'email'], 'redact');

  assert.match(out, /email: redact/);
  assert.ok(out.includes('# Hajiz DLP gateway - organization policy.'));
  assert.ok(out.includes('# On `redact` versus `block` for credentials.'));
  assert.ok(out.includes('# The gate: swept, not guessed.'));
  assert.equal(SAMPLE.split('\n').length, out.split('\n').length, 'no lines added or removed');
});

test('a trailing comment on the edited line survives', () => {
  const out = setScalar(SAMPLE, ['actions', 'email'], 'block');
  assert.match(out, /email: block\s+# trailing note/);
});

test('the rest of the file parses to exactly what it did before', () => {
  const before = yaml.load(SAMPLE);
  const after = yaml.load(setScalar(SAMPLE, ['actions', 'email'], 'block'));

  before.actions.email = 'block';
  assert.deepEqual(after, before, 'only the edited value may differ');
});

test('a nested path under a group is reached', () => {
  const out = setScalar(SAMPLE, ['groups', 'engineering', 'actions', 'source_code'], 'block');
  assert.equal(yaml.load(out).groups.engineering.actions.source_code, 'block');
  assert.equal(yaml.load(out).actions.email, 'pseudonymize', 'the top-level key of the same name is untouched');
});

test('a number is written unquoted and reads back as a number', () => {
  const out = setScalar(SAMPLE, ['thresholds', 'sentence_hot_above'], 0.55);
  assert.match(out, /sentence_hot_above: 0\.55/);
  assert.equal(yaml.load(out).thresholds.sentence_hot_above, 0.55);
});

test('a value needing quotes gets them', () => {
  const out = setScalar(SAMPLE, ['name'], 'Policy: strict, v2');
  assert.equal(yaml.load(out).name, 'Policy: strict, v2');
});

test('a key that is a block is refused rather than overwritten', () => {
  // Rewriting the `actions:` line would orphan every class beneath it.
  assert.throws(() => setScalar(SAMPLE, ['actions'], 'block'), /block, not a single value/);
});

test('a key that does not exist is refused rather than invented', () => {
  assert.throws(() => setScalar(SAMPLE, ['actions', 'not_a_class'], 'block'), /no actions\.not_a_class/);
});

test('the watchlist can be replaced, and keeps the keys around it', () => {
  const out = setList(SAMPLE, ['watchlist'], ['Project Falcon', 'Saned', 'Qamar-7 قمر']);
  const parsed = yaml.load(out);

  assert.deepEqual(parsed.watchlist, ['Project Falcon', 'Saned', 'Qamar-7 قمر']);
  assert.ok(parsed.groups.engineering, 'the block after the list survives');
  assert.equal(parsed.escalation.wait_for_human_ms, 90000, 'the block before it survives');
});

test('an empty watchlist does not swallow the next block', () => {
  const parsed = yaml.load(setList(SAMPLE, ['watchlist'], []));
  assert.deepEqual(parsed.watchlist ?? [], []);
  assert.ok(parsed.groups.engineering);
});

test('several edits apply together, and one bad path changes nothing', () => {
  const out = applyEdits(SAMPLE, [
    { path: ['actions', 'email'], value: 'redact' },
    { path: ['escalation', 'auto_decisions_before_block'], value: 5 },
  ]);
  const parsed = yaml.load(out);
  assert.equal(parsed.actions.email, 'redact');
  assert.equal(parsed.escalation.auto_decisions_before_block, 5);

  assert.throws(() =>
    applyEdits(SAMPLE, [
      { path: ['actions', 'email'], value: 'redact' },
      { path: ['actions', 'nope'], value: 'block' },
    ]),
  );
});

test('findKey does not confuse two keys of the same name at different depths', () => {
  // `actions:` appears twice - once at the top level and once inside a group.
  // Matching the wrong one would write a group override into the global rules.
  const top = findKey(SAMPLE, ['actions']);
  const nested = findKey(SAMPLE, ['groups', 'engineering', 'actions']);

  assert.equal(top.indent, 0);
  assert.ok(nested.indent > 0, 'the nested one is indented');
  assert.ok(nested.line > top.line);
  assert.match(SAMPLE.split('\n')[top.line], /^actions:/);
});

test('the real policy.yaml survives a round trip', () => {
  // The file this actually ships against, rather than a sample built to pass.
  const real = fs.readFileSync(new URL('../policy.yaml', import.meta.url), 'utf8');
  const before = yaml.load(real);
  const out = setScalar(real, ['actions', 'email'], 'redact');
  const after = yaml.load(out);

  before.actions.email = 'redact';
  assert.deepEqual(after, before);
  assert.equal(
    (real.match(/^\s*#/gm) ?? []).length,
    (out.match(/^\s*#/gm) ?? []).length,
    'every comment line is still there',
  );
});
