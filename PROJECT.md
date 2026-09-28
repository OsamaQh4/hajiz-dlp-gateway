# SAIF 2026 — AI-Powered DLP Gateway for Enterprise LLM Use

**Track:** Cybersecurity & Defensive Technologies (الأمن السيبراني والتقنيات الدفاعية)
**Event:** SAIF / GSTS — Riyadh, 24–26 Nov 2026
**Team:** solo
**Working name options:** `Hajiz` (حاجز — barrier), `Sentra`, `PromptShield`

---

## 1. The problem

Enterprises want employees to use frontier LLMs (Claude, ChatGPT, Gemini, Copilot).
Security teams can't allow it, because a prompt is an unlogged, unclassified,
free-text egress channel straight out of the perimeter. Current answers are both bad:

- **Block everything** → shadow AI on personal devices, zero visibility, worse leakage.
- **Allow everything** → customer PII, source code, contracts, and internal project
  names leave the organization with no record.

Classic DLP (regex/fingerprint) was built for files and email. It cannot judge a
sentence like *"our unreleased Falcon platform has an auth bypass in the SSO module"* —
no pattern matches it, yet it is the most damaging thing an employee could paste.

**Saudi hook:** PDPL + SDAIA/NCA controls make cross-border transfer of personal and
classified data a legal question, not a preference. A judging model that can run
fully in-Kingdom / on-prem is a compliance requirement, not a feature.

## 2. The differentiator — don't redact, pseudonymize reversibly

Everyone in this space (Purview, Netskope, Nightfall, Prompt Security, Harmonic)
blocks or masks. Masking breaks the answer: replace the values with `[REDACTED]` and
the model can no longer reason about them, so employees route around the tool.

**Our approach:** consistent, reversible pseudonymization at the gateway.

```
Employee prompt : "Customer Ahmed Al-Otaibi (ID 1098xxxxxx) reported that Project
                   Falcon fails auth on login, here's the trace..."
                        ↓ tokenize (vault holds mapping, never leaves the org)
Sent to Claude  : "Customer PERSON_1 (ID ID_1) reported that Project ENTITY_1
                   fails auth on login, here's the trace..."
                        ↓ model answers coherently about PERSON_1 / ENTITY_1
Shown to user   : full answer, with the real names restored
```

Pitch line: **"We don't trade productivity for protection — we decouple them."**
The model keeps full semantic structure; the sensitive strings never cross the
perimeter; the mapping vault is per-session, encrypted, and auditable.

## 3. Architecture

```
VDI / workstation
   └─ traffic to *.anthropic.com, *.openai.com, claude.ai, chatgpt.com
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│  DLP GATEWAY (container / virtual appliance, in-tenant)       │
│                                                               │
│  1. INTERCEPT                                                 │
│     • TLS-inspecting forward proxy (corp root CA on golden    │
│       image — same pattern as Zscaler/Netskope)               │
│     • OR API gateway mode (drop-in base_url swap)             │
│     • per-provider adapter extracts the real prompt/file      │
│       payload out of each vendor's request JSON               │
│                                                               │
│  2. DETECT — two tiers (cost + latency)                       │
│     Tier A  regex + NER + entropy: national ID, IBAN, card,   │
│             email, phone, API keys, internal hostnames/IPs,   │
│             source-code fingerprints.  ~1 ms, catches ~90%    │
│     Tier B  LLM judge: semantic leakage — unreleased product  │
│             names, M&A talk, undisclosed vulns, contract      │
│             terms. Only fires when Tier A is ambiguous or     │
│             the prompt is long-form prose.                    │
│             Judge is pluggable: on-prem (Llama/Qwen/Allam)    │
│             or hosted, per org policy.                        │
│                                                               │
│  3. ACT — policy engine                                       │
│     allow │ pseudonymize │ warn-and-confirm │ block │ escalate│
│     to human reviewer (borderline confidence)                 │
│                                                               │
│  4. VAULT  session-scoped token↔value map, encrypted at rest  │
│  5. REHYDRATE  swap real values back into the response        │
│  6. AUDIT  immutable log: who, when, what class, what action  │
└───────────────────────────────────────────────────────────────┘
        │
        ▼  sanitized request
   Claude / ChatGPT / Gemini
```

**Why two tiers matters in the pitch:** the first question a judge asks is
*"doesn't an LLM call on every prompt destroy latency and cost?"*
Answer: it doesn't, because most traffic never reaches Tier B.

## 4. MVP scope — what actually gets built

Build (must work live on stage) — **all of this is now built and tested**:

- [x] **Gateway in API-proxy mode** — Anthropic + OpenAI compatible endpoints.
      An employee/tool points at `http://gateway:8080/v1/...` and it just works.
- [x] **Tier A detectors** — Saudi national ID/Iqama, IBAN, phone, email, card
      (Luhn), API keys/secrets (entropy + known prefixes), internal IP/hostname.
- [x] **Tier B LLM judge** — structured-output classifier returning
      `{spans, class, confidence, rationale}`; prompt-injection-resistant
      (judge input is wrapped as data, never instructions).
- [x] **Reversible pseudonymization + rehydration** — the demo centerpiece.
- [x] **Policy engine** — YAML policy: class → action, per group.
- [x] **Admin dashboard** — live feed of prompts, what was caught, what class,
      what action, latency per tier. This is what sells it visually.
- [x] **Streaming support** — rehydrate tokens on the fly, not after the fact
      (easy to forget; breaks the demo if missed).

Added during the build, not in the original plan:

- [x] **Human-in-the-loop escalation queue** — low-confidence judge findings hold
      the prompt and wait for a reviewer in the dashboard. This was in the pitch
      as a claim; now it is a working flow, which is a much better demo beat.
- [x] **Hash-chained audit log** — tamper-evident, and it logs classes and
      decisions rather than the values it protected.
- [x] **Mock upstream mode** — the whole pipeline runs with no network and no API
      key. Conference wifi can no longer break the demo.
- [x] **Benchmark harness** — precision/recall/latency over a labeled corpus, so
      there is a number on the slide instead of a vibe.

Describe in the deck as roadmap, do **not** build:

- TLS-MITM browser interception for claude.ai / chatgpt.com web UIs
- On-prem model hosting/fine-tuning of the judge
- GPO/PAC deployment tooling, SIEM connectors, SSO/RBAC
- File-type coverage beyond text (PDF/DOCX/images with OCR)

## 5. Repo structure

```
gateway/
  proxy/        provider adapters (anthropic.py, openai.py), streaming
  detect/
    tier_a/     regex, NER, entropy, validators (Luhn, IBAN, Iqama checksum)
    tier_b/     judge client, prompt templates, structured output schema
  policy/       policy.yaml loader, decision engine
  vault/        token mint, session map, encryption, TTL
  audit/        append-only event log
dashboard/      web UI: live stream + metrics
bench/          leak corpus + false-positive corpus, latency harness
docs/           architecture diagram, pitch deck, threat model
```

## 5a. Status

Built, with 41 passing tests including full end-to-end through the HTTP server.
See [README.md](README.md) for how to run it and [docs/demo-script.md](docs/demo-script.md)
for the stage script. Remaining work is the deck, and a real evaluation corpus to
replace the hand-built benchmark.

## 6. Build order

1. Proxy passthrough that forwards to Anthropic unchanged + logs — prove the wire works.
2. Tier A detectors + unit tests over a small labeled corpus.
3. Pseudonymize → forward → rehydrate, non-streaming. **First real demo moment.**
4. Streaming rehydration.
5. Tier B judge + confidence routing.
6. Policy engine + audit log.
7. Dashboard.
8. Benchmark numbers (precision/recall, p50/p95 latency) — judges want a number, not a vibe.
9. Deck + diagram + 3-minute demo script.

## 7. Live demo script (3 minutes)

1. Show the dashboard, idle. Show the policy file.
2. Paste a realistic support ticket containing a customer name, Iqama number,
   and an internal project codename into a normal chat client pointed at the gateway.
3. Split view: **what the employee typed** vs **what actually left the network**.
4. The model's answer comes back — coherent, and with the real names restored.
5. Then paste something with no regex-detectable pattern at all
   ("we're acquiring X next quarter, draft the internal memo") → Tier B catches it,
   policy escalates, dashboard shows the rationale.
6. Show the audit trail. End on the latency chart.

## 8. Judge Q&A — prepare answers

| Question | Answer |
|---|---|
| Latency? | Two-tier: Tier A ~1 ms on ~90% of traffic; show p95. |
| False positives? | Confidence bands + warn-and-confirm + human escalation; show the FP rate on the benchmark corpus. |
| Isn't the judge itself an LLM that sees the data? | Yes — that's why it's pluggable and can run fully on-prem. Nothing leaves the Kingdom. |
| Prompt injection against the judge? | Judge input is wrapped as data with a fixed schema; it emits labels, never actions. |
| Purview / Netskope already do this. | They mask; masking degrades the answer, so users route around it. Reversible pseudonymization is the difference — plus in-Kingdom judging for PDPL. |
| What if the employee uses their phone? | Out of scope; this covers managed egress, which is where policy is enforceable. |

## 9. Key dates

| Milestone | Date |
|---|---|
| Registration opened | 22 Jul 2026 |
| **Registration closes** | **28 Sep 2026** |
| Finalists announced | 4 Oct 2026 |
| Exhibition + competition (in person) | 24–26 Nov 2026 |
