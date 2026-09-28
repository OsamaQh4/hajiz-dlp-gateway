import { EventEmitter } from 'node:events';

/**
 * In-process event bus feeding the dashboard over SSE, plus a ring buffer so a
 * dashboard that connects late still has recent history to render.
 */
class Bus extends EventEmitter {
  #ring = [];
  #max = 250;

  publish(event) {
    const stamped = { ts: Date.now(), ...event };
    this.#ring.push(stamped);
    if (this.#ring.length > this.#max) this.#ring.shift();
    this.emit('event', stamped);
    return stamped;
  }

  recent(n = 50) {
    return this.#ring.slice(-n);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);

/** Rolling latency/decision metrics for the dashboard header. */
export const metrics = {
  requests: 0,
  byAction: { allow: 0, pseudonymize: 0, escalate: 0, block: 0 },
  tierBCalls: 0,
  tierALatencies: [],
  tierBLatencies: [],
  totalLatencies: [],

  record({ action, escalated = false, tierAMs, tierBMs, totalMs }) {
    this.requests += 1;
    if (this.byAction[action] !== undefined) this.byAction[action] += 1;
    // An approved escalation is finally recorded as `pseudonymize`, so without
    // this the "held for a human" count would always read zero.
    if (escalated && action !== 'escalate') this.byAction.escalate += 1;
    push(this.tierALatencies, tierAMs);
    if (tierBMs != null) {
      this.tierBCalls += 1;
      push(this.tierBLatencies, tierBMs);
    }
    push(this.totalLatencies, totalMs);
  },

  snapshot() {
    return {
      requests: this.requests,
      byAction: { ...this.byAction },
      tierBCalls: this.tierBCalls,
      tierBRate: this.requests ? this.tierBCalls / this.requests : 0,
      tierA: percentiles(this.tierALatencies),
      tierB: percentiles(this.tierBLatencies),
      total: percentiles(this.totalLatencies),
    };
  },
};

function push(arr, v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return;
  arr.push(v);
  if (arr.length > 1000) arr.shift();
}

export function percentiles(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(s[s.length - 1]) };
}

const round = (n) => Math.round(n * 100) / 100;
