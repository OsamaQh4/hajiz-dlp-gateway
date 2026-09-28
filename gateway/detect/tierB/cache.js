import crypto from 'node:crypto';

/**
 * Judge result cache, keyed by the exact text that was judged.
 *
 * A chat client resends the whole conversation on every turn, so without this
 * the gateway re-judges the entire history each time: turn 20 pays for twenty
 * turns of text. Caching per message means only genuinely new content reaches
 * the model, which turns a quadratic cost into a linear one.
 *
 * Keys are hashes, and the cache holds only spans and classes - never the text
 * itself - so it is not a second copy of the data the gateway is protecting.
 */

const MAX_ENTRIES = 500;
const TTL_MS = 60 * 60 * 1000;

const store = new Map();
let hits = 0;
let misses = 0;

export const keyFor = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** @returns {Array|null} cached findings with segment-local offsets, or null */
export function get(text) {
  const key = keyFor(text);
  const entry = store.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  if (Date.now() - entry.at > TTL_MS) {
    store.delete(key);
    misses += 1;
    return null;
  }
  // Refresh recency so hot prefixes (a long system prompt) are never evicted.
  store.delete(key);
  store.set(key, entry);
  hits += 1;
  return entry.findings;
}

export function set(text, findings) {
  const key = keyFor(text);
  store.delete(key);
  store.set(key, { at: Date.now(), findings });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

export function stats() {
  const total = hits + misses;
  return { entries: store.size, hits, misses, hitRate: total ? hits / total : 0 };
}

export function clear() {
  store.clear();
  hits = 0;
  misses = 0;
}
