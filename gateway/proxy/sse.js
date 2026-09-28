/**
 * Minimal SSE framing. We have to parse the upstream stream rather than pipe it
 * through untouched: placeholders live inside JSON string fields, so restoring
 * them means decoding each event, rewriting the text, and re-encoding it.
 */

/** Incrementally split a byte stream into SSE events. */
export class SSEParser {
  #buffer = '';

  /** @returns {Array<{event:string|null, data:string, raw:string}>} */
  push(chunk) {
    this.#buffer += chunk;
    const out = [];
    let idx;
    while ((idx = this.#buffer.search(/\r?\n\r?\n/)) !== -1) {
      const match = /\r?\n\r?\n/.exec(this.#buffer.slice(idx));
      const raw = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + match[0].length);
      if (raw.trim()) out.push(parseBlock(raw));
    }
    return out;
  }

  flush() {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest.trim() ? [parseBlock(rest)] : [];
  }
}

function parseBlock(raw) {
  let event = null;
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n'), raw };
}

export function serialize({ event, data }) {
  const lines = [];
  if (event) lines.push(`event: ${event}`);
  for (const line of String(data).split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}
