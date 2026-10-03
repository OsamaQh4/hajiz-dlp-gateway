import { config } from '../config.js';
import { serialize } from './sse.js';

/**
 * Provider adapters.
 *
 * Every vendor wraps the employee's actual words in its own JSON shape, so the
 * gateway needs a thin adapter per provider to find the text, put the sanitized
 * text back, and restore placeholders in the reply. This is the unglamorous
 * part that makes "works with the tools we already use" true.
 */

const isTextBlock = (b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string';

/** Restore placeholders in every string of an already-parsed value. */
function rehydrateDeep(value, rehydrate) {
  if (typeof value === 'string') return rehydrate(value);
  if (Array.isArray(value)) return value.map((v) => rehydrateDeep(v, rehydrate));
  if (value && typeof value === 'object') {
    const out = {};
    // Keys can carry a placeholder too - a tool argument named after a project.
    for (const [k, v] of Object.entries(value)) out[rehydrate(k)] = rehydrateDeep(v, rehydrate);
    return out;
  }
  return value;
}

/** Collect editable text spans out of a request body. */
function collectContent(content, push) {
  if (typeof content === 'string') return; // handled by caller (needs the parent ref)
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (isTextBlock(block)) {
      push({
        get text() {
          return block.text;
        },
        set: (v) => {
          block.text = v;
        },
      });
    } else if (block?.type === 'document' && block.source?.type === 'base64' && /^text\//.test(block.source.media_type || '')) {
      // Uploaded plain-text files are inspected too - a pasted prompt and an
      // attached file are the same leak with different packaging.
      const decoded = Buffer.from(block.source.data, 'base64').toString('utf8');
      let value = decoded;
      push({
        get text() {
          return value;
        },
        set: (v) => {
          value = v;
          block.source.data = Buffer.from(v, 'utf8').toString('base64');
        },
      });
    } else if (block?.type === 'tool_result') {
      collectContent(block.content, push);
    }
  }
}

export const anthropicAdapter = {
  name: 'anthropic',
  route: '/v1/messages',
  upstreamBase: () => config.upstream.anthropic,
  upstreamPath: '/v1/messages',

  segments(body) {
    const segs = [];
    const push = (s) => segs.push(s);

    if (typeof body.system === 'string') {
      push({
        get text() {
          return body.system;
        },
        set: (v) => {
          body.system = v;
        },
      });
    } else {
      collectContent(body.system, push);
    }

    for (const msg of body.messages ?? []) {
      if (typeof msg.content === 'string') {
        push({
          get text() {
            return msg.content;
          },
          set: (v) => {
            msg.content = v;
          },
        });
      } else {
        collectContent(msg.content, push);
      }
    }
    return segs;
  },

  rehydrateResponse(json, rehydrate) {
    for (const block of json?.content ?? []) {
      if (isTextBlock(block)) block.text = rehydrate(block.text);
      // A tool call carries the agent's actual work. Leaving placeholders here
      // means the agent writes PERSON_1 into a file on disk.
      else if (block?.type === 'tool_use') block.input = rehydrateDeep(block.input, rehydrate);
    }
    return json;
  },

  /** @returns {string} bytes to forward downstream for this upstream event */
  rewriteEvent({ event, data }, ctx) {
    if (data === '[DONE]') return serialize({ event, data });
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return serialize({ event, data }); // pass through anything we can't read
    }

    const index = payload.index ?? 0;

    // Remember which blocks carry tool arguments: those arrive as fragments of
    // a JSON string, so replacements in them have to be escaped.
    if (payload.type === 'content_block_start') {
      const isTool = payload.content_block?.type === 'tool_use';
      const r = ctx.for(index, { json: isTool });
      if (isTextBlock(payload.content_block)) payload.content_block.text = r.push(payload.content_block.text);
      return serialize({ event, data: JSON.stringify(payload) });
    }

    if (payload.type === 'content_block_delta') {
      const delta = payload.delta ?? {};
      if (delta.type === 'text_delta') {
        delta.text = ctx.for(index).push(delta.text);
        return serialize({ event, data: JSON.stringify(payload) });
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        delta.partial_json = ctx.for(index, { json: true }).push(delta.partial_json);
        return serialize({ event, data: JSON.stringify(payload) });
      }
      return serialize({ event, data });
    }

    // The block is ending, so anything still held back can no longer grow into
    // a placeholder. Release it as one last delta before the stop event.
    if (payload.type === 'content_block_stop') {
      const r = ctx.for(index);
      const tail = r.flush();
      const prefix = tail
        ? serialize({
            event: 'content_block_delta',
            data: JSON.stringify({
              type: 'content_block_delta',
              index,
              delta: r.json ? { type: 'input_json_delta', partial_json: tail } : { type: 'text_delta', text: tail },
            }),
          })
        : '';
      return prefix + serialize({ event, data });
    }

    return serialize({ event, data });
  },

  /**
   * A policy block is not an authentication problem, and the status code has to
   * say so. Returning 403 made Claude Code print "Please run /login" above our
   * message - in a real deployment that sends every blocked employee to the
   * help desk convinced their account is broken. 400 carries the explanation
   * without prescribing the wrong remedy.
   */
  errorResponse(message, details) {
    return {
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message },
        dlp: details,
      },
    };
  },

  mockReply(body, promptText) {
    const text = mockAssistantText(promptText);
    return {
      id: `msg_mock_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: body.model || 'mock-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  },

  mockStream(body, promptText) {
    const text = mockAssistantText(promptText);
    const chunks = splitForStreaming(text);
    const events = [
      {
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            id: `msg_mock_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: body.model || 'mock-model',
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      },
      {
        event: 'content_block_start',
        data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      },
      ...chunks.map((c) => ({
        event: 'content_block_delta',
        data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }),
      })),
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      {
        event: 'message_delta',
        data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }),
      },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    return events;
  },
};

export const openaiAdapter = {
  name: 'openai',
  route: '/v1/chat/completions',
  upstreamBase: () => config.upstream.openai,
  upstreamPath: '/v1/chat/completions',

  segments(body) {
    const segs = [];
    const push = (s) => segs.push(s);
    for (const msg of body.messages ?? []) {
      if (typeof msg.content === 'string') {
        push({
          get text() {
            return msg.content;
          },
          set: (v) => {
            msg.content = v;
          },
        });
      } else {
        collectContent(msg.content, push);
      }
    }
    return segs;
  },

  rehydrateResponse(json, rehydrate) {
    for (const choice of json?.choices ?? []) {
      if (typeof choice?.message?.content === 'string') {
        choice.message.content = rehydrate(choice.message.content);
      }
      for (const call of choice?.message?.tool_calls ?? []) {
        // Arguments are a JSON string, so patching them needs escaping.
        if (typeof call?.function?.arguments === 'string') {
          call.function.arguments = rehydrate(call.function.arguments, { json: true });
        }
      }
    }
    return json;
  },

  rewriteEvent({ event, data }, ctx) {
    if (data === '[DONE]') {
      const tail = ctx.flushAll().map((t) => t.text).join('');
      const prefix = tail
        ? serialize({
            event,
            data: JSON.stringify({
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
            }),
          })
        : '';
      return prefix + serialize({ event, data });
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return serialize({ event, data });
    }
    let touched = false;
    for (const choice of payload?.choices ?? []) {
      const i = choice.index ?? 0;
      if (typeof choice?.delta?.content === 'string') {
        choice.delta.content = ctx.for(i).push(choice.delta.content);
        touched = true;
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        if (typeof call?.function?.arguments === 'string') {
          call.function.arguments = ctx.for(`${i}:tool${call.index ?? 0}`, { json: true }).push(call.function.arguments);
          touched = true;
        }
      }
    }
    return serialize({ event, data: touched ? JSON.stringify(payload) : data });
  },

  errorResponse(message, details) {
    return {
      status: 400,
      body: {
        error: { message, type: 'invalid_request_error', code: 'dlp_blocked' },
        dlp: details,
      },
    };
  },

  mockReply(body, promptText) {
    return {
      id: `chatcmpl_mock_${Date.now()}`,
      object: 'chat.completion',
      model: body.model || 'mock-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: mockAssistantText(promptText) }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  },

  mockStream(body, promptText) {
    const chunks = splitForStreaming(mockAssistantText(promptText));
    return [
      ...chunks.map((c) => ({
        event: null,
        data: JSON.stringify({
          object: 'chat.completion.chunk',
          model: body.model || 'mock-model',
          choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
        }),
      })),
      { event: null, data: '[DONE]' },
    ];
  },
};

/**
 * The offline stand-in for a frontier model. It deliberately echoes the
 * placeholders it was given, because that is exactly what a real model does -
 * and it is what makes rehydration visible on stage without a network.
 */
function mockAssistantText(promptText) {
  const tokens = [...new Set((promptText.match(/\b[A-Z]+_\d+\b/g) || []))];
  const mentioned = tokens.length
    ? `Working from what you sent: ${tokens.join(', ')}. ` +
      tokens.map((t) => `I have kept ${t} consistent throughout this answer.`).join(' ')
    : 'There was nothing sensitive to substitute in this prompt.';
  return (
    `[mock upstream - no network call was made]\n\n${mentioned}\n\n` +
    'Because the gateway replaced the sensitive values before this request left your network, ' +
    'I could still reason about the case normally. The real values were restored on the way back to you.'
  );
}

/** Split into small pieces, on purpose mid-placeholder, to exercise hold-back. */
function splitForStreaming(text, size = 7) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export const adapters = [anthropicAdapter, openaiAdapter];
export const adapterForPath = (pathname) => adapters.find((a) => a.route === pathname) || null;
