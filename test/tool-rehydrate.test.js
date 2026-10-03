import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../gateway/vault/vault.js';
import { anthropicAdapter, openaiAdapter } from '../gateway/proxy/adapters.js';

/**
 * Rehydrating tool calls.
 *
 * A coding agent's real work arrives as tool arguments, not prose. The
 * rehydrator only handled text, so a placeholder inside a Write call was
 * forwarded untouched and the agent wrote PERSON_1 into a file on disk -
 * permanently, and silently. These are the tests that would have caught it.
 */

const setup = () => {
  const vault = new Vault();
  const text = 'Contact Ahmed Al-Otaibi about Project Falcon';
  const findings = [
    { start: 8, end: 23, cls: 'person', detector: 'judge', confidence: 1, tier: 'B' },
    { start: 30, end: 44, cls: 'project', detector: 'watchlist', confidence: 1, tier: 'A' },
  ];
  const { text: sanitized } = vault.tokenize('s1', text, findings);
  return { vault, sanitized };
};

const sse = (payload, event) => ({ event: event ?? payload.type, data: JSON.stringify(payload) });
const collect = (out) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());

test('a tool call in a non-streamed reply is rehydrated', () => {
  const { vault } = setup();
  const reply = {
    content: [
      { type: 'text', text: 'Writing the note for PERSON_1.' },
      { type: 'tool_use', name: 'Write', input: { file_path: 'notes.md', content: 'Owner: PERSON_1 — PROJECT_1' } },
    ],
  };

  const out = anthropicAdapter.rehydrateResponse(reply, (t, o) => vault.rehydrate('s1', t, o));
  assert.equal(out.content[1].input.content, 'Owner: Ahmed Al-Otaibi — Project Falcon');
  assert.ok(!/PERSON_1|PROJECT_1/.test(JSON.stringify(out)), 'no placeholder may reach the agent');
});

test('nested and array tool arguments are reached', () => {
  const { vault } = setup();
  const reply = {
    content: [
      {
        type: 'tool_use',
        name: 'MultiEdit',
        input: { edits: [{ old: 'PERSON_1', new: 'x' }, { note: { by: 'PROJECT_1' } }] },
      },
    ],
  };
  const out = anthropicAdapter.rehydrateResponse(reply, (t, o) => vault.rehydrate('s1', t, o));
  assert.equal(out.content[0].input.edits[0].old, 'Ahmed Al-Otaibi');
  assert.equal(out.content[0].input.edits[1].note.by, 'Project Falcon');
});

test('a streamed tool call is rehydrated, split mid-placeholder', () => {
  const { vault } = setup();
  const ctx = vault.streamContext('s1');
  const chunks = ['{"file_path":"n', 'otes.md","content":"Owner: PER', 'SON_1 and PROJ', 'ECT_1"}'];

  let out = '';
  out += anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Write', input: {} } }),
    ctx,
  );
  for (const c of chunks) {
    out += anthropicAdapter.rewriteEvent(
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: c } }),
      ctx,
    );
  }
  out += anthropicAdapter.rewriteEvent(sse({ type: 'content_block_stop', index: 0 }), ctx);

  const assembled = collect(out)
    .map((d) => JSON.parse(d))
    .filter((p) => p.delta?.type === 'input_json_delta')
    .map((p) => p.delta.partial_json)
    .join('');

  const parsed = JSON.parse(assembled);
  assert.equal(parsed.content, 'Owner: Ahmed Al-Otaibi and Project Falcon');
});

test('a value containing quotes does not corrupt the tool call', () => {
  // The reason tool arguments need their own escaping rule: the placeholder is
  // always safe characters, but the value behind it may not be.
  const vault = new Vault();
  const text = 'Contact Ahmed "Abu Sami" Al-Otaibi';
  const { text: sanitized } = vault.tokenize('s1', text, [
    { start: 8, end: 34, cls: 'person', detector: 'judge', confidence: 1, tier: 'B' },
  ]);
  const token = sanitized.match(/PERSON_\d+/)[0];

  const ctx = vault.streamContext('s1');
  let out = anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Write', input: {} } }),
    ctx,
  );
  out += anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"c":"${token}"}` } }),
    ctx,
  );
  out += anthropicAdapter.rewriteEvent(sse({ type: 'content_block_stop', index: 0 }), ctx);

  const assembled = collect(out)
    .map((d) => JSON.parse(d))
    .filter((p) => p.delta?.type === 'input_json_delta')
    .map((p) => p.delta.partial_json)
    .join('');

  assert.doesNotThrow(() => JSON.parse(assembled), 'the tool call must still be valid JSON');
  assert.equal(JSON.parse(assembled).c, 'Ahmed "Abu Sami" Al-Otaibi');
});

test('prose and tool arguments do not share a hold-back buffer', () => {
  const { vault } = setup();
  const ctx = vault.streamContext('s1');

  let out = anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ctx,
  );
  out += anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Noting PERSON_1 now. ' } }),
    ctx,
  );
  out += anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write', input: {} } }),
    ctx,
  );
  out += anthropicAdapter.rewriteEvent(
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"c":"PERSON_1"}' } }),
    ctx,
  );
  out += anthropicAdapter.rewriteEvent(sse({ type: 'content_block_stop', index: 0 }), ctx);
  out += anthropicAdapter.rewriteEvent(sse({ type: 'content_block_stop', index: 1 }), ctx);

  assert.ok(!/PERSON_1/.test(out), 'neither block may leak a placeholder');
  assert.match(out, /Ahmed Al-Otaibi/);
});

test('OpenAI tool arguments are rehydrated too', () => {
  const { vault } = setup();
  const reply = {
    choices: [
      {
        message: {
          content: 'done',
          tool_calls: [{ function: { name: 'write', arguments: '{"owner":"PERSON_1"}' } }],
        },
      },
    ],
  };
  const out = openaiAdapter.rehydrateResponse(reply, (t, o) => vault.rehydrate('s1', t, o));
  assert.equal(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments).owner, 'Ahmed Al-Otaibi');
});
