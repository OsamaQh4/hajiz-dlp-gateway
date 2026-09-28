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
    }
    return json;
  },

  /** @returns {string} bytes to forward downstream for this upstream event */
  rewriteEvent({ event, data }, rehydrator) {
    if (data === '[DONE]') return serialize({ event, data });
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return serialize({ event, data }); // pass through anything we can't read
    }

    if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
      payload.delta.text = rehydrator.push(payload.delta.text);
      return serialize({ event, data: JSON.stringify(payload) });
    }

    if (payload.type === 'content_block_start' && isTextBlock(payload.content_block)) {
      payload.content_block.text = rehydrator.push(payload.content_block.text);
      return serialize({ event, data: JSON.stringify(payload) });
    }

    // The block is ending, so anything still held back can no longer grow into
    // a placeholder. Release it as one last delta before the stop event.
    if (payload.type === 'content_block_stop') {
      const tail = rehydrator.flush();
      const prefix = tail
        ? serialize({
            event: 'content_block_delta',
            data: JSON.stringify({
              type: 'content_block_delta',
              index: payload.index ?? 0,
              delta: { type: 'text_delta', text: tail },
            }),
          })
        : '';
      return prefix + serialize({ event, data });
    }

    return serialize({ event, data });
  },

  errorResponse(message, details) {
    return {
      status: 403,
      body: {
        type: 'error',
        error: { type: 'permission_error', message },
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
    }
    return json;
  },

  rewriteEvent({ event, data }, rehydrator) {
    if (data === '[DONE]') {
      const tail = rehydrator.flush();
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
      if (typeof choice?.delta?.content === 'string') {
        choice.delta.content = rehydrator.push(choice.delta.content);
        touched = true;
      }
    }
    return serialize({ event, data: touched ? JSON.stringify(payload) : data });
  },

  errorResponse(message, details) {
    return {
      status: 403,
      body: {
        error: { message, type: 'permission_error', code: 'dlp_blocked' },
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
