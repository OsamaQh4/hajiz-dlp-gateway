import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTierA, resolveOverlaps } from '../gateway/detect/tierA/index.js';
import { luhn, saudiId, iban, looksLikeSecret } from '../gateway/detect/tierA/validators.js';
import { shouldRunTierB } from '../gateway/detect/index.js';
import { mapToSpans, heuristicFindings } from '../gateway/detect/tierB/judge.js';

const classesIn = (findings) => new Set(findings.map((f) => f.cls));

test('checksum validators accept real values and reject near-misses', () => {
  assert.ok(luhn('4111111111111111'));
  assert.ok(!luhn('4111111111111112'));

  assert.ok(saudiId('1098765439'));
  assert.ok(!saudiId('1098765431'), 'wrong check digit');
  assert.ok(!saudiId('3098765439'), 'must start with 1 or 2');

  assert.ok(iban('SA0380000000608010167519'));
  assert.ok(!iban('SA0380000000608010167518'));

  assert.ok(looksLikeSecret('Zx8Q2vK9mB4nR7tW1cY6hL0pS5dF3gJ8'));
  assert.ok(!looksLikeSecret('9f2c1a7d4b8e3f6a0c5d2e1b7a4f8c3d9e6b2a10'), 'git SHA is not a secret');
  assert.ok(!looksLikeSecret('3f7c2b1e-9d84-4a6f-b2c1-7e5a9d3c8b40'), 'UUID is not a secret');
});

test('tier A finds structured identifiers', () => {
  const text =
    'Ahmed, ID 1098765439, card 4111111111111111, IBAN SA0380000000608010167519, ' +
    'mail a@b.sa, phone +966512345678, host auth-01.corp.internal';
  const found = scanTierA(text);
  for (const cls of ['national_id', 'card', 'iban', 'email', 'phone', 'internal_host']) {
    assert.ok(classesIn(found).has(cls), `expected to find ${cls}`);
  }
});

test('tier A leaves clean prose alone', () => {
  const text =
    'Explain the difference between symmetric and asymmetric encryption for data at rest, in under 200 words.';
  assert.equal(scanTierA(text).length, 0);
});

test('watchlist catches codenames no vendor model has ever seen', () => {
  const found = scanTierA('Risks for Project Falcon before Sunday.', { watchlist: ['Project Falcon'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].cls, 'project');
  assert.equal(found[0].detector, 'watchlist');
});

test('watchlist does not match inside a longer word', () => {
  const found = scanTierA('The Sanedex index is public.', { watchlist: ['Saned'] });
  assert.equal(found.length, 0);
});

test('a sentence-level finding is not displaced by an identifier inside it', () => {
  // These carry different actions - `project` pseudonymizes, `strategic`
  // escalates. Dropping the wider one substituted the counterparty and
  // forwarded the deal, which is the residual leak measured at 96%.
  const resolved = resolveOverlaps([
    { start: 16, end: 21, cls: 'project', detector: 'watchlist', priority: 85, confidence: 1, tier: 'A' },
    { start: 0, end: 60, cls: 'strategic', detector: 'jev', confidence: 0.95, tier: 'B', semantic: true },
  ]);
  assert.equal(resolved.length, 2, 'both granularities must survive');
  assert.ok(resolved.some((f) => f.cls === 'strategic'));
  assert.ok(resolved.some((f) => f.cls === 'project'));
});

test('partially overlapping claims still resolve to one', () => {
  // Containment is the exception, not overlap in general.
  const resolved = resolveOverlaps([
    { start: 0, end: 20, cls: 'secret', detector: 'high_entropy_secret', priority: 30, confidence: 0.6 },
    { start: 10, end: 30, cls: 'email', detector: 'email', priority: 60, confidence: 0.99 },
  ]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].cls, 'email');
});

test('overlapping claims resolve to the higher-priority detector', () => {
  const resolved = resolveOverlaps([
    { start: 0, end: 24, cls: 'secret', detector: 'high_entropy_secret', priority: 30, confidence: 0.6 },
    { start: 0, end: 24, cls: 'iban', detector: 'iban', priority: 70, confidence: 0.98 },
  ]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].cls, 'iban');
});

test('tier B is skipped on short prompts and on conclusive secrets', () => {
  const policy = { tier_b: { enabled: true, min_chars: 80, min_words: 12 } };

  assert.equal(shouldRunTierB('what is 2+2?', [], policy).run, false);

  const longProse =
    'Please help me write a detailed and carefully worded explanation of our current position for the committee meeting.';
  assert.equal(shouldRunTierB(longProse, [], policy).run, true);

  const withSecret = [{ cls: 'secret', confidence: 1 }];
  assert.equal(shouldRunTierB(longProse, withSecret, policy).run, false);

  assert.equal(shouldRunTierB(longProse, [], { tier_b: { enabled: false } }).run, false);
});

test('judge spans are located in the text, and hallucinated spans are dropped', () => {
  const text = 'We are acquiring Saned next quarter and it is not yet public.';
  const spans = mapToSpans(text, [
    { text: 'acquiring Saned next quarter', cls: 'strategic', confidence: 0.9, rationale: 'undisclosed M&A' },
    { text: 'a company that was never mentioned', cls: 'org', confidence: 0.9, rationale: 'hallucinated' },
  ]);
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), 'acquiring Saned next quarter');
});

test('judge output is constrained to known classes', () => {
  const spans = mapToSpans('some text here', [{ text: 'some text here', cls: 'not_a_class', confidence: 1 }]);
  assert.equal(spans.length, 0);
});

test('degraded heuristic still flags obvious semantic cues', () => {
  const found = heuristicFindings('This is confidential: we are acquiring a competitor next quarter.');
  assert.ok(found.length > 0);
  assert.ok(found.every((f) => f.tier === 'B'));
});
