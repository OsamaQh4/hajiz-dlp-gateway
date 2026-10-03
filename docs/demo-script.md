# Three-minute demo script

Run everything in **mock mode**. It needs no network and no API key, which means
conference wifi cannot break the demo. If the venue's network is good and you want a real
model in the loop, export `ANTHROPIC_API_KEY` and drop `DLP_UPSTREAM_MODE=mock`.

**Setup before you walk on** (PowerShell — one line per command, `&&` is not valid there):

```powershell
$env:DLP_UPSTREAM_MODE="mock"
npm start
```

Two windows, side by side: the dashboard at <http://localhost:8080> on the projector, a
terminal below it. Have all four scenario commands already typed in separate tabs.

---

### 0:00 — The setup (20 seconds, no slides)

> "Every organization here wants their people using Claude and ChatGPT. And every security
> team here has the same problem: a prompt is a free-text channel straight out of the
> perimeter, with no logging and no classification. Blocking it gives you shadow AI on
> personal phones. Allowing it gives you this."

Show the dashboard, idle. Point at the policy line in the footer.

### 0:20 — Ordinary PII (45 seconds)

```bash
node scripts/demo-client.js --scenario 1
```

Let the split screen land before you say anything. Left: what the employee typed, the
sensitive spans in red. Right: what actually left the network.

> "Name, national ID, phone, email, an internal codename, an internal hostname. None of it
> left the building. But look at the answer the employee got back — the real values are
> there. We didn't redact, we substituted, and we substituted back on the way home."

Point at the mappings table: class, which detector caught it, which tier, confidence.

### 1:05 — The thing nobody else catches (40 seconds)

```bash
node scripts/demo-client.js --scenario 3
```

This one has no regex-detectable pattern anywhere in it.

> "Nothing in this prompt matches any pattern. There's no ID, no card, no key. It's just a
> sentence about an acquisition that hasn't been announced. That's the leak that actually
> ends careers, and it's the one classic DLP cannot see."

The escalation banner appears. Let it sit for a beat.

> "The system isn't confident enough to decide alone, so it doesn't. It holds the prompt
> and asks a person."

Click **Approve**. The terminal completes.

### 1:45 — The hard stop (25 seconds)

```bash
node scripts/demo-client.js --scenario 2
```

> "A live API key and a production database password. No substitution, no review queue —
> this one just doesn't go. And the employee gets told why, which is the difference
> between a control people work with and one they work around."

### 2:10 — Latency and evidence (35 seconds)

Point at the tiles.

> "Tier A is regex and checksums: p50 is two hundredths of a millisecond. The semantic
> judge is a decision model, not a chatbot — it returns a probability, not prose, in
> about four hundred milliseconds, and only on text long enough to hide something.
> That is the answer to 'doesn't an AI call on every prompt kill latency'."

Click **Verify audit chain**.

> "Every decision is hash-chained. Delete one record and this goes red and tells you which
> one. And note what's in the log: classes and decisions, never the values we protected."

### 2:45 — The close (15 seconds)

> "The judge is pluggable. Point it at a model on your own hardware and no prompt text
> leaves the Kingdom at all — which under PDPL isn't a feature, it's the requirement.
> Everything you just saw runs in one container inside the tenant."

**If you are running the hosted stand-in judge, say this, and say it before anyone asks:**

> "One disclosure: the judge you just watched is Gemma, the same open model you'd run
> in-tenant — but today it's hosted, because I'm not carrying a GPU. The code path is
> identical; only the hostname differs. The gateway knows, which is why the footer says
> STAND-IN. In production that hostname is inside your network and nothing leaves."

Check the footer before you start: amber **STAND-IN** means hosted, plain text means
genuinely in-tenant.

---

## If something breaks

| Symptom | Fix |
|---|---|
| Gateway won't start, "port already in use" | an older instance is still running. `$env:DLP_PORT=8090; npm start`, then pass `--gateway http://localhost:8090` to the client — or stop the old one: `Get-NetTCPConnection -LocalPort 8080 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` |
| Dashboard is empty | it only renders live traffic; run a scenario |
| Escalation never appears | scenario 3 needs the judge or the degraded cues; check the footer says which judge is active |
| Judge returns 401, or the footer says heuristic | run `npm run doctor` — it prints what is set, what resolved, and what the judge endpoint actually replied |
| A scenario hangs | that's the escalation queue waiting — approve it in the dashboard, or wait for the timeout |

## Questions to expect, and the answers

| Question | Answer |
|---|---|
| Latency? | Two tiers. Show the tiles: Tier A p50, and the Tier B rate. |
| False positives? | Show `npm run bench` — and say plainly that the corpus is small and hand-built. |
| Isn't your judge an LLM that sees all the data? | Yes. That's why it's pluggable and runs on-prem. Nothing leaves the Kingdom. |
| Prompt injection against the judge? | Input is wrapped as data under a fixed schema, and it emits labels, never actions. Scenario in the corpus: `leak-injection-attempt`. |
| Purview and Netskope already do this. | They mask. Masking degrades the answer, so people route around it. Reversible pseudonymization plus in-Kingdom judging is the difference. |
| What if the employee uses their phone? | Out of scope, honestly. This governs managed egress, which is where policy is enforceable at all. |
