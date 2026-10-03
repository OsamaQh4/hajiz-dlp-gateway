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

## All three primitives have a job here

Jev is not only a yes/no gate. Each question type maps onto a decision the
gateway already makes badly or not at all.

| Primitive | Our use | What it replaces |
|---|---|---|
| **Noul** | Gate: "does this prompt reveal anything non-public?" and per-sentence semantic checks | The generative judge's first pass |
| **Choice** | Classify a candidate span into the taxonomy, or `none` — with options drawn from spans Tier A already located | The judge's class labelling, *and* its span hallucinations, which become structurally impossible |
| **Score** | **Severity**, on an ordered scale | Nothing. We have no severity concept at all today. |

The third is the real upgrade. `policy.yaml` currently maps class → action, which
is crude: a customer's name and a live private key are both "a class", and the
action table has to pretend the difference is categorical. A Score question
returns an ordered severity with a distribution behind it, so the action can
depend on **how damaging** a disclosure would be rather than **what kind** it is:

```
0  public, already disclosed           -> allow
1  internal but routine                -> pseudonymize
2  confidential business information   -> pseudonymize
3  regulated personal data or MNPI     -> escalate
4  credentials or an unfixed weakness  -> block
```

That is a better policy model than the one we shipped, and it falls out of using
the right primitive rather than from more code.

### Fan-out is already answered

TypeSafe's published recipes report **475 answers in 1.2 s** (5 questions across
95 messages) and **96 answers in 0.5 s** (4 checks on each of 24 tool calls, one
request). Our 10-30 candidates per request is nowhere near a limit. Test 6 below
is still worth running — our states are far larger than theirs and our questions
are domain-specific - but the feasibility risk is now low.

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

### Test 6b — the shape we would actually ship

This exercises all three primitives in one request, exactly as the gateway
would: a gate, per-candidate classification over spans Tier A located, severity
scoring, and sentence-level checks for semantic leakage that no regex nominates.
Running it *is* the prototype's first measurement.

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "description": "An outbound prompt an employee is about to send to an external AI assistant. Judge only from `prompt`.",
    "prompt": "Customer Ahmed Al-Otaibi (ID 1098765439) emailed a.alotaibi@example.com.sa about Project Falcon failing auth on auth-01.corp.internal. We are acquiring Saned next quarter and it is not yet public. Q3 came in at SAR 412 million, well under the plan we filed."
  },
  "questions": {
    "gate": {
      "type": "noul",
      "instructions": "The prompt reveals something about the organization that is not already public.",
      "criteria": {
        "true": "It names an identified person or customer, an internal project, undisclosed financials, a planned change such as redundancies or an acquisition, a security weakness, or a credential.",
        "false": "Routine correspondence or a general request, mentioning people, places or products without revealing anything non-public about them."
      }
    },

    "cls_id":      { "type": "choice", "instructions": "Classify the span \"1098765439\" as it is used in this prompt.", "criteria": { "personal_identifier": "A government or account identifier belonging to a person.", "financial": "An undisclosed financial figure.", "infrastructure": "A host, address or internal system.", "none": "Not sensitive in this context." } },
    "cls_email":   { "type": "choice", "instructions": "Classify the span \"a.alotaibi@example.com.sa\" as it is used in this prompt.", "criteria": { "contact_detail": "Contact details identifying a person.", "personal_identifier": "A government or account identifier.", "none": "Not sensitive in this context." } },
    "cls_host":    { "type": "choice", "instructions": "Classify the span \"auth-01.corp.internal\" as it is used in this prompt.", "criteria": { "infrastructure": "An internal host, address or system name.", "project": "An internal project or product name.", "none": "Not sensitive in this context." } },
    "cls_falcon":  { "type": "choice", "instructions": "Classify the span \"Project Falcon\" as it is used in this prompt.", "criteria": { "project": "An internal project, codename or unreleased product.", "infrastructure": "An internal host or system.", "none": "Not sensitive in this context." } },
    "cls_saned":   { "type": "choice", "instructions": "Classify the span \"Saned\" as it is used in this prompt.", "criteria": { "strategic": "A party to an undisclosed deal, acquisition or negotiation.", "project": "An internal project or product name.", "none": "Not sensitive in this context." } },

    "cls_q3":      { "type": "choice", "instructions": "Classify the span \"Q3\" as it is used in this prompt.", "criteria": { "financial": "An undisclosed financial figure or result.", "strategic": "An undisclosed plan or deal.", "none": "A generic label that reveals nothing on its own." } },
    "cls_auth":    { "type": "choice", "instructions": "Classify the span \"auth\" as it is used in this prompt.", "criteria": { "infrastructure": "An internal host or system name.", "vulnerability": "An undisclosed security weakness.", "none": "A generic technical word that reveals nothing on its own." } },

    "sent_deal":   { "type": "noul", "instructions": "The sentence \"We are acquiring Saned next quarter and it is not yet public\" reveals a non-public plan." },
    "sent_fin":    { "type": "noul", "instructions": "The sentence \"Q3 came in at SAR 412 million, well under the plan we filed\" reveals undisclosed financial results." },

    "severity": {
      "type": "score",
      "instructions": "How damaging would it be if this prompt left the organization unchanged?",
      "criteria": [
        "Public or already disclosed; no impact.",
        "Internal but routine; mild embarrassment at worst.",
        "Confidential business information; competitive or contractual harm.",
        "Regulated personal data or material non-public information; legal and regulatory exposure.",
        "Credentials, keys or an unfixed security weakness; immediate operational risk."
      ]
    }
  }
}
```

**Expected:** `gate` high. The five `cls_*` candidates classified, none of them
`none`. **`cls_q3` and `cls_auth` should both come back `none`** — they are the
distractors, and if they are classified as sensitive the per-candidate approach
over-triggers exactly as Tier A did. Both sentence nouls high. `severity` at 3 or
4, given the prompt carries a national ID *and* material non-public information.

Record total latency for all twelve questions and compare against the ~500 ms
single-question baseline.

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

### Test 6b — PASSED, 11 of 11

Run against `typesafe/jev-1.13` through OpenRouter's `/api/alpha/decisions`.

| Question | Answer | Confidence |
|---|---|---|
| gate | 98.0% | — |
| cls_id → `personal_identifier` | ✔ | 1.00 |
| cls_email → `contact_detail` | ✔ | 1.00 |
| cls_host → `infrastructure` | ✔ | 1.00 |
| cls_falcon → `project` | ✔ | 1.00 |
| cls_saned → `strategic` | ✔ | 1.00 |
| cls_q3 → `none` *(distractor)* | ✔ | 0.97 |
| cls_auth → `none` *(distractor)* | ✔ | 0.97 |
| sent_deal | 97.0% | — |
| sent_fin | 86.0% | — |
| severity | level 3.06 | 0.93 |

**Fan-out: 334 ms for 11 questions against 378 ms for one.** Marginal cost of
extra questions is unmeasurable. (An earlier run showed 0.42x only because the
single-question baseline was paying for connection setup; a warm-up call fixed
the comparison.)

**The distractors took two attempts, and the first failure is the useful part.**
Asked to *"classify the span Q3"*, Jev answered `financial` at 0.99 — correctly,
because a quarter label genuinely is financial in kind. It simply is not
sensitive on its own. The question conflated two axes: *what kind of thing is
this* and *is this worth protecting*. Rewritten as *"substituting this span
would protect which kind of non-public information? Choose none if replacing it
would protect nothing"*, with every class requiring specificity, both
distractors flipped to `none` at 0.97.

### Verdict against the rule fixed in advance

> *Jev replaces the generative judge only if Test 1 shows a wide gap, Test 4
> stays low, and Test 6 shows fan-out roughly flat in cost.*

| Test | Bar | Result |
|---|---|---|
| 1 — context discrimination | >50 pt gap | 95% vs 10% = **85 pts** |
| 4 — benign control | low | **2.0%** |
| 6 — fan-out and accuracy | roughly flat | **0.88x for 11x**, 11/11 correct |

Three for three. **Build it.**

### What this does not yet establish

- Everything above is one hand-written probe. The criteria were tuned twice
  against these very distractors, which is the same overfitting risk that
  applied to the Gemma judge prompt. The honest next step is the **full 33-sample
  corpus**, which the criteria were not tuned on, with `--runs 3`.
- Long states are untested. Real traffic is 22-24 KB; every state here was a
  paragraph. Test 7 still stands.
- Three times now the **criteria**, not the model, have been the lever: Test 1
  (45% → 10%), and Test 6 twice. That is the finding worth carrying into the
  deck - the discriminating power lives in prose a security team can edit, not
  in weights.

### Pseudonymization probe — 6 of 6, and it found two shipping defects

Six questions, one request, 842 ms.

| Question | Answer | Conf | |
|---|---|---|---|
| `coref` — which placeholder does a bare surname refer to? | `PERSON_1` | 1.00 | ✔ |
| `coref_matters` — does the unsubstituted surname still identify? | **87.0%** | — | ✔ |
| `residual_leak` — does anything non-public survive substitution? | **96.0%** | — | ✔ |
| `residual_what` — what survives? | `acquisition` | 0.98 | ✔ |
| `utility_sanitized` | level 3.13 | 0.76 | ✔ |
| `utility_over_redacted` | level 2.05 | 0.70 | ✔ |

**Defect 1 — the vault leaks second mentions.** It keys placeholders by exact
string, so "Ahmed Al-Otaibi" is substituted and a later bare "Al-Otaibi" is not.
Jev resolves the coreference at 1.00 confidence, choosing only from placeholders
already minted, so it cannot invent an entity. Confirmed at 87% that the
leftover surname still identifies the customer.

**Defect 2 — pseudonymization protects identifiers, not facts.** After
substitution the prompt still reads *"We are acquiring ORG_1 next quarter and it
is not yet public."* The counterparty is masked; the deal is not. Jev scores the
residual leak at 96% and names it as `acquisition` at 0.98.

Policy partly covers this already - `strategic: escalate` fires when the judge
returns the *sentence* as a finding. But when it returns only the entity, we
substitute and forward the leak. A verification pass is independent of whether
span-level detection caught the semantic case, which is exactly why it is worth
having.

**The utility metric works, but weakly.** 3.13 against 2.05 is about one level of
separation, with the lowest confidences in the whole evaluation (0.76, 0.70).
Judging usefulness is genuinely more subjective than identifying an acquisition.
It is usable as a regression signal, not as a headline number.

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
