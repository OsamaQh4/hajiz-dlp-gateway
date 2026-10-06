import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(v));
const int = (v, dflt) => (v === undefined ? dflt : Number.parseInt(v, 10));

export const config = {
  port: int(process.env.DLP_PORT, 8080),

  /**
   * A separate port for the console and its API.
   *
   * Unset means both share `port`, which is simplest to run and is what the
   * demo does. On a shared port any application that can send a prompt can
   * also reach the administrative API, and is one credential away from
   * rewriting policy. Setting this lets a firewall rule say "employees here,
   * administrators there" - the console is then unreachable from the network
   * employee traffic arrives on.
   */
  adminPort: process.env.DLP_ADMIN_PORT ? int(process.env.DLP_ADMIN_PORT, 9090) : null,

  /**
   * The in-path forward proxy.
   *
   * Unset means off, and the gateway only serves clients that were pointed at
   * it by configuration. Set, and managed machines can be routed through this
   * port instead: the employee changes nothing, and HTTPS to the AI hosts is
   * terminated here with a certificate from the inspection CA.
   */
  proxyPort: process.env.DLP_PROXY_PORT ? int(process.env.DLP_PROXY_PORT, 8888) : null,

  /** PEM paths. When set, the console is served over TLS instead of HTTP. */
  tls: {
    cert: process.env.DLP_TLS_CERT || null,
    key: process.env.DLP_TLS_KEY || null,
  },

  /**
   * live  - forward to the real provider
   * mock  - synthesize an upstream reply locally. No network, no API key.
   *         Exists so the stage demo still works on bad conference wifi.
   *
   * Anything else is refused at startup rather than guessed at: defaulting a
   * typo to `live` sends real traffic outward, and defaulting it to `mock` would
   * let someone believe prompts are protected when nothing is being forwarded.
   */
  upstreamMode: process.env.DLP_UPSTREAM_MODE || 'live',

  /**
   * enforce - act on the decision: pseudonymize, escalate, block.
   * observe  - detect, score, log and dashboard everything, but forward the
   *            request completely unmodified.
   *
   * Real DLP deployments never start in enforcement. They run in monitor mode
   * first, so a security team can see what their people are actually sending
   * before anything is blocked or rewritten. It is also the only safe way to
   * point a live coding agent at this gateway: nothing it sends gets altered,
   * so the agent cannot be corrupted by a substitution we got wrong.
   */
  mode: process.env.DLP_MODE || 'enforce',

  upstream: {
    anthropic: process.env.DLP_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    openai: process.env.DLP_OPENAI_BASE_URL || 'https://api.openai.com',
  },

  /**
   * The Tier B judge. `provider: "anthropic"` uses the official SDK; point
   * `baseUrl` at an in-tenant gateway to keep judging inside the perimeter.
   * `provider: "local"` talks to any OpenAI-compatible server (vLLM, Ollama,
   * llama.cpp) running on the organization's own hardware - the PDPL /
   * data-residency path, where no prompt text leaves the building at all.
   */
  judge: {
    /**
     * jev       - a decision model. The default: 2.3x faster at the median and
     *             5.8x at p95, it returns the same findings on every run, its
     *             confidence is calibrated rather than self-reported, and it
     *             cannot hallucinate a span because it only ever chooses among
     *             options we supply. It costs about nine points of span recall
     *             against a generative judge, which is the trade.
     * anthropic - a generative judge through the official SDK.
     * local     - any OpenAI-compatible server the organization runs itself.
     */
    provider: process.env.DLP_JUDGE_PROVIDER || 'jev',
    // Swap to claude-haiku-4-5 or claude-sonnet-5 to trade judge accuracy for
    // latency and cost on high-volume deployments.
    model: process.env.DLP_JUDGE_MODEL || 'claude-opus-5',
    baseUrl: process.env.DLP_JUDGE_BASE_URL || undefined,
    apiKey: process.env.DLP_JUDGE_API_KEY || process.env.ANTHROPIC_API_KEY,
    effort: process.env.DLP_JUDGE_EFFORT || 'low',
    // The judge emits a small JSON object, not prose. A high ceiling does not
    // make it smarter - it just lets a chatty model ramble past the timeout.
    maxTokens: int(process.env.DLP_JUDGE_MAX_TOKENS, 1500),
    // Self-hosted servers and shared free endpoints queue; 12s is tight for a
    // cold or contended model.
    timeoutMs: int(process.env.DLP_JUDGE_TIMEOUT_MS, 30000),
    // Retries for transient upstream failures (429, 5xx, timeouts). Shared
    // endpoints rate-limit hard, and real inference servers stall under load.
    retries: int(process.env.DLP_JUDGE_RETRIES, 2),
  },

  /**
   * The decision-model judge. Reached through OpenRouter's decisions endpoint,
   * or point it at a local Kev server, which serves the same contract.
   */
  jev: {
    endpoint: process.env.DLP_JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions',
    model: process.env.DLP_JEV_MODEL || 'typesafe/jev-1.13',
    apiKey: process.env.DLP_JUDGE_API_KEY || process.env.OPENROUTER_API_KEY,
  },

  vault: {
    // Session mappings live in memory; persistence is AES-256-GCM encrypted.
    persist: bool(process.env.DLP_VAULT_PERSIST, false),
    keyHex: process.env.DLP_VAULT_KEY || '',
    ttlMs: int(process.env.DLP_VAULT_TTL_MS, 12 * 60 * 60 * 1000),
    file: path.join(ROOT, 'data', 'vault.enc'),
  },

  policyPath: process.env.DLP_POLICY || path.join(ROOT, 'policy.yaml'),
  auditPath: process.env.DLP_AUDIT_LOG || path.join(ROOT, 'data', 'audit.jsonl'),

  /**
   * DEMO ONLY. Sends the pre-sanitization text to the dashboard so the
   * split-screen "typed vs. sent" view works. In a real deployment this is
   * off: the whole point is that the plaintext never travels anywhere.
   */
  dashboardShowPlaintext: bool(process.env.DLP_DASHBOARD_PLAINTEXT, true),

  // How long a human reviewer has to approve an escalated prompt.
  escalationTimeoutMs: int(process.env.DLP_ESCALATION_TIMEOUT_MS, 90000),
};

export const UPSTREAM_MODES = ['live', 'mock'];
export const MODES = ['enforce', 'observe'];
export const isMock = () => config.upstreamMode === 'mock';
export const isObserve = () => config.mode === 'observe';

/** Hostnames that can only resolve inside the organization's own network. */
function isInTenantHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return /\.(internal|intranet|corp|local|lan)$/.test(h);
}

/**
 * Where the judge actually runs.
 *
 * The data-residency claim is the heart of the pitch, so the gateway works this
 * out for itself rather than taking the operator's word for it. A judge pointed
 * at a hosted endpoint is reported as `external` even when the provider is set
 * to `local` - which is exactly the case when a hosted open model is standing
 * in for an on-prem one during a demo. Say it on the slide; don't let someone
 * discover it.
 *
 * @returns {{residency:'in-tenant'|'external', host:string, standIn:boolean}}
 */
/** The model actually doing the judging, whichever provider is selected. */
export const judgeModel = () => (config.judge.provider === 'jev' ? config.jev.model : config.judge.model);

export function judgeResidency() {
  const { provider, baseUrl } = config.judge;
  const effective =
    provider === 'jev'
      ? config.jev.endpoint
      : baseUrl || (provider === 'local' ? 'http://localhost:11434/v1' : 'https://api.anthropic.com');
  let host = effective;
  try {
    host = new URL(effective).hostname;
  } catch {
    /* an unparseable value is treated as external, which is the safe reading */
  }
  const inTenant = isInTenantHost(host);
  return {
    residency: inTenant ? 'in-tenant' : 'external',
    host,
    // provider=local means "an OpenAI-compatible server I run"; if that server
    // is reachable on the public internet, it is a stand-in, not the real thing.
    // provider=local means "a server I run"; jev is hosted by definition, so it
    // is only a stand-in for an on-prem Kev if someone claims otherwise.
    standIn: (provider === 'local' || provider === 'jev') && !inTenant,
  };
}

/** @returns {string|null} a human-readable problem, or null if the config is usable */
export function validateConfig() {
  if (!MODES.includes(config.mode)) {
    return (
      `DLP_MODE is "${config.mode}", which is not a mode.\n` +
      `  Valid values: ${MODES.join(', ')}.\n` +
      '  "enforce" acts on decisions; "observe" detects and logs but forwards\n' +
      '  every request untouched.'
    );
  }
  if (!UPSTREAM_MODES.includes(config.upstreamMode)) {
    return (
      `DLP_UPSTREAM_MODE is "${config.upstreamMode}", which is not a mode.\n` +
      `  Valid values: ${UPSTREAM_MODES.join(', ')}.\n` +
      '  This variable chooses whether the gateway forwards to a real provider or\n' +
      '  answers locally. It is not where you set a model — that is DLP_JUDGE_MODEL\n' +
      '  for the judge, or the "model" field in the request for the upstream call.'
    );
  }
  return null;
}
