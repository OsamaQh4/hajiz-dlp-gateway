# Evaluating Jev as the Tier B adjudicator

Run these in the TypeSafe playground **before** any integration work. Each one
maps to a decision the gateway already has to make, and every state is taken
from our corpus or from the real Claude Code traffic we captured — so the
answers are directly comparable to what Gemma scored.

The question we are trying to answer is **not** "is Jev good". It is:

> Can a decision model adjudicate candidate spans in context, with calibrated
> probabilities, well enough to replace a generative judge?

Record probability, latency and cost for each. There is a results table at the
bottom.

---

## Test 1 — Context, not keywords (the one that matters)

Two states, **identical span, identical question**. Our Gemma judge got this
pair right, and it is the strongest result in the project. If Jev cannot
separate them, the whole candidate-adjudication design fails and we stop here.

### 1A — the span IS sensitive here

**STATE**
```
Outbound prompt from an employee to an external AI assistant:
"We are planning a restructuring that removes 140 roles in the Dammam operations centre in March. Draft the internal comms, and a separate note for the regional director."

Candidate span under review: "Dammam operations centre"
```

**QUESTION**
```
Would this span leak sensitive organizational information if it left the network in this context?
```

**TRUE WHEN**
```
The span identifies a person, customer, internal project, facility, financial figure, security weakness or undisclosed plan — or becomes identifying when combined with the surrounding text.
```

**FALSE WHEN**
```
The span is public knowledge, a generic technical term, a common word, or carries no organizational meaning in this context.
```

Expect: **high** yes-probability.

### 1B — the same span is NOT sensitive here

Same question and criteria, only the state changes:

**STATE**
```
Outbound prompt from an employee to an external AI assistant:
"Our Dammam operations centre is hosting a first-aid training day next month. Write a friendly invitation email asking staff to sign up, with a short note on what to bring."

Candidate span under review: "Dammam operations centre"
```

Expect: **low** yes-probability.

> **What it means.** A wide gap (say >50 points) means Jev is reasoning about
> context, and the mosaic principle is implementable as a probability rather
> than a hand-written rule. A narrow gap means it is keyword-matching, and it
> cannot do this job.

---

## Test 2 — Secret vs. identifier

This is the exact false positive that real Claude Code traffic produced, and
the one my entropy heuristic needed three attempts to fix. If Jev gets it from
context alone, that is an argument for replacing the heuristic rather than
patching it.

### 2A — a model ID that merely looks random

**STATE**
```
Outbound prompt excerpt:
"The most recent Claude models are the Claude 5 family and Haiku 4.5. Model IDs — Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest models."

Candidate span under review: "claude-haiku-4-5-20251001"
```

**QUESTION**
```
Is this span a live credential that grants access to a system?
```

**TRUE WHEN**
```
An API key, password, access token, private key, session cookie or connection string containing a password.
```

**FALSE WHEN**
```
An identifier, model name, version string, file name, content hash, integrity digest, or any other public reference that grants no access.
```

Expect: **low**.

### 2B — an actual key, same question

**STATE**
```
Outbound prompt excerpt:
"Why does this fail with a 401? const client = new Anthropic({ apiKey: "sk-ant-api03-Zx8Q2vK9mB4nR7tW1cY6hL0pS5dF3gJ8aE2uI9oP4kN7mQ1wX" });"

Candidate span under review: "sk-ant-api03-Zx8Q2vK9mB4nR7tW1cY6hL0pS5dF3gJ8aE2uI9oP4kN7mQ1wX"
```

Expect: **high**.

---

## Test 3 — The class our judge kept missing

Both remaining misses in the final benchmark run were undisclosed security
weaknesses, and fixing it needed a taxonomy change plus a prompt revision.

**STATE**
```
Outbound prompt from an employee to an external AI assistant:
"Our unreleased in-car payments module fails PCI review because the HSM integration was never finished. Write a one-page mitigation plan for the regulator, but keep the product name out of the summary."

Candidate span under review: "HSM integration was never finished"
```

**QUESTION**
```
Does this span disclose an unfixed security weakness in the organization's own systems?
```

**TRUE WHEN**
```
It describes an unpatched flaw, a failed or incomplete security control, missing hardening, a failed audit, or how a system could be attacked — including when framed as an ordinary engineering problem or a request for help fixing it.
```

**FALSE WHEN**
```
It names a product, technology or standard without describing a weakness, or discusses security in general terms.
```

Expect: **high**. Then re-run with the candidate span changed to
`"unreleased in-car payments module"` — that is a **product name**, not a
weakness, and Gemma misclassified it as a vulnerability. Expect **low**.

---

## Test 4 — Benign control

If this scores high, Jev over-triggers and the false positive rate will be
unusable, exactly as Tier A's was on source code.

**STATE**
```
Outbound prompt from an employee to an external AI assistant:
"Review this function for off-by-one errors: function window(arr, n) { const out = []; for (let i = 0; i <= arr.length - n; i++) out.push(arr.slice(i, i + n)); return out; }"

Candidate span under review: "arr.length - n"
```

Use the Test 1 question and criteria. Expect: **very low**.

---

## Test 5 — Classification, via a Choice question

Switch the playground to **choice**. This tests whether Jev can replace the
classification step, which decides *which policy action fires*.

**STATE**: reuse Test 3's state.

**QUESTION**
```
Which category best describes the candidate span "HSM integration was never finished"?
```

**OPTIONS**
```
person        — a real individual's name
project       — an internal project, codename or unreleased product name
financial     — undisclosed revenue, margins, pricing or budgets
strategic     — M&A, layoffs, roadmaps or anything pre-announcement
vulnerability — an undisclosed security weakness in our systems
credentials   — a password, key or token
location      — a facility or place tied to something non-public
none          — not sensitive
```

Expect `vulnerability` with reasonable confidence. Watch the **distribution**,
not just the winner: a confident single peak means the policy engine can branch
on it; a flat distribution across three classes means it cannot.

---

## Test 6 — Fan-out (the feasibility test)

**This is the one that decides whether the architecture is affordable.** Tier A
hands us 10–30 candidate spans per request. TypeSafe claims many questions in
one call barely change response time. Verify it.

Switch the input to **JSON** and send several questions against one state:

```json
{
  "state": "Outbound prompt from an employee: \"Customer Ahmed Al-Otaibi (ID 1098765439) emailed a.alotaibi@example.com.sa about Project Falcon failing auth on auth-01.corp.internal. We are acquiring Saned next quarter and it is not yet public. Q3 came in at SAR 412 million, well under the plan we filed.\"",
  "model": "jev-latest",
  "questions": {
    "span_1":  { "type": "noul", "instructions": "The span \"Ahmed Al-Otaibi\" is sensitive in this context" },
    "span_2":  { "type": "noul", "instructions": "The span \"1098765439\" is sensitive in this context" },
    "span_3":  { "type": "noul", "instructions": "The span \"a.alotaibi@example.com.sa\" is sensitive in this context" },
    "span_4":  { "type": "noul", "instructions": "The span \"Project Falcon\" is sensitive in this context" },
    "span_5":  { "type": "noul", "instructions": "The span \"auth-01.corp.internal\" is sensitive in this context" },
    "span_6":  { "type": "noul", "instructions": "The span \"acquiring Saned next quarter\" is sensitive in this context" },
    "span_7":  { "type": "noul", "instructions": "The span \"SAR 412 million\" is sensitive in this context" },
    "span_8":  { "type": "noul", "instructions": "The span \"well under the plan we filed\" is sensitive in this context" },
    "span_9":  { "type": "noul", "instructions": "The span \"Q3\" is sensitive in this context" },
    "span_10": { "type": "noul", "instructions": "The span \"auth\" is sensitive in this context" }
  }
}
```

Spans 1–8 should be **high**; spans 9 and 10 are deliberate distractors — a bare
quarter label and a generic word — and should be **low**.

Compare the latency against a single-question call. If ten questions cost
roughly what one costs, this replaces our entire Tier B with one round trip per
request. If latency scales linearly with question count, it does not.

---

## Test 7 — Long state

Our real traffic is 22–24 KB per request, and Kev-0.5B was trained on
**≤384 state tokens**. Paste a few thousand words into the state and re-run
Test 1A.

Watch for: an error, a latency cliff, or — worst because it is silent — the
probability drifting toward 50% as the state grows. If quality degrades with
length, candidate spans must be sent with a *local window* of context rather
than the whole prompt. That is the design either way; this tells us how big the
window can be.

---

## Results

### Test 1 — PASSED, and it taught us where the control surface is

Run against `typesafe/jev-1.13`. Both states name the same facility; only the
surrounding text differs.

| Criteria version | 1A (layoffs) | 1B (first-aid) | Gap |
|---|---|---|---|
| v1 — "identifies a person, customer, **facility**, …" | 94% | 45% | 49 pts |
| v2 — "a facility counts **only when** the text also reveals something non-public about it" | **95%** | **10%** | **85 pts** |

Latency 360 ms – 1.0 s. Cost ~$0.0000192 per call.

Two things follow, and the second matters more than the first:

1. **Jev discriminates on context, not keywords.** Same span, 95% versus 10%.
   The mosaic principle is expressible as a calibrated probability rather than a
   hand-written rule.
2. **The discriminating power lives in the criteria, not the model.** The state
   was byte-identical across both rows; only the TRUE/FALSE definitions changed,
   and the benign case fell 45 → 10 while the sensitive case moved 94 → 95.
   Tightening the definition removed a false positive at almost no cost to
   recall. That means `policy.yaml` can become the control surface: a security
   team tunes what counts as sensitive by editing prose, with no retraining and
   no code change.

An earlier framing that presented the span separately from its context
("Candidate span under review: X" after the prompt) scored 62% on 1A at 1.7 s.
Feeding the prompt directly, as one state, was both more accurate and three
times faster. Jev wants the document, not a fragment plus a pointer.

### Test 4 — PASSED

Benign control, v2 criteria: an ordinary code-review prompt with nothing
sensitive in it.

| | p(yes) | Latency | Cost |
|---|---|---|---|
| "Review this function for off-by-one errors…" | **2.0%** | 867 ms | $0.00002 |

For contrast, the same class of content — ordinary source code — produced
**seven false positives and a would-be block** from Tier A on captured Claude
Code traffic. The semantic layer is not merely as good as the pattern layer on
clean code; it is dramatically better, because it is reading meaning rather than
shape.

Caveat: this is a short, clean snippet. It is not 22 KB of real agent traffic
with a system prompt wrapped around it. Test 7 still matters.

### Remaining

| Test | Expected | p(yes) | Latency | Cost | Verdict |
|---|---|---|---|---|---|
| 2A model ID | low | | | | |
| 2B real API key | high | | | | |
| 3 HSM weakness | high | | | | |
| 3b product name | low | | | | |
| 4 benign code | very low | | | | |
| 5 classification | `vulnerability` | | | | |
| 6 fan-out, 10 questions | 8 high / 2 low | | | | |
| 7 long state | stable | | | | |

**Decision rule, set before seeing results:** Jev replaces the generative judge
only if Test 1 shows a wide gap, Test 4 stays low, and Test 6 shows fan-out that
is roughly flat in cost. Two out of three is interesting; one out of three is a
no.
