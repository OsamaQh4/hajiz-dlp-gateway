# Running real traffic through the gateway

Everything measured so far came from a 33-prompt corpus that I wrote. This test
replaces that with traffic nobody designed for it: a real coding agent, doing
real work, sending whatever it actually sends.

The point is not to demonstrate that the gateway works. It is to find out where
it does not.

---

## What we are testing

| Question | How we answer it |
|---|---|
| Does the gateway break a real client? | Claude Code either keeps working through it, or it doesn't. |
| What does Tier A fire on in real code? | Read the dashboard; every finding is a false positive unless the prompt genuinely contained something sensitive. |
| What does the gateway cost? | Latency per request on the dashboard tiles. |
| Does judge caching actually hold up? | Cache hit rate across a long conversation. |

**Hypothesis worth stating before we start:** Tier A will produce a false
positive rate on source code that would be unacceptable in enforcement. If it
does, that is the finding, and the answer is tuning plus context — not
pretending the corpus number generalizes.

---

## Safety first — read this part

**Run in `observe` mode.** It detects, scores, logs and dashboards everything,
then forwards the request completely unmodified. Nothing is rewritten, nothing
is blocked, nothing waits on a human.

**Do not switch to `enforce` while a live agent is connected.** In enforcement
the gateway substitutes values inside the prompt. For a coding agent that means
placeholders can end up written into your files — and the response rehydrator
only restores text, not tool-call arguments. Enforcement is for chat clients,
not for agents, until tool-input handling exists.

**The kill switch** is one line in the client's terminal. If anything misbehaves:

```powershell
Remove-Item Env:\ANTHROPIC_BASE_URL
```

Claude Code goes straight back to talking to Anthropic directly. The gateway is
a proxy, not an install — there is nothing to uninstall.

**Use a scratch project for the first run.** Pointing the agent at *this* repo
will light up the dashboard with the fake keys and codenames in `bench/corpus.json`,
which is entertaining but tells you nothing. Use something unrelated and boring.

---

## Prerequisites

The test needs a **command-line** Claude Code, separate from the desktop app.
The desktop app bundles its own copy and does not put `claude` on PATH, and you
do not want to route the session you are working in through the gateway you are
testing — a bug there takes out the tool you would use to fix it.

```powershell
npm install -g @anthropic-ai/claude-code
```

Open a new terminal afterwards so PATH refreshes, then confirm:

```powershell
claude --version
```

**For Phase 3 (WSL)** you also need Node inside the distro. A bare Ubuntu will
appear to have `npm` because WSL inherits the Windows PATH, but `node` is
missing — the Windows install ships an extensionless `npm` script and a
`node.exe`, and only the former resolves. Install a real one:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec bash
nvm install --lts
npm install -g @anthropic-ai/claude-code
```

## Phase 1 — native Windows, Tier A only

Start simple. This proves the plumbing with the fewest moving parts.

### Terminal 1 — the gateway

```powershell
cd "C:\Users\Osama\OneDrive\سطح المكتب\SAIF Challange"
```

```powershell
$env:DLP_MODE="observe"; $env:DLP_UPSTREAM_MODE="live"; $env:DLP_PORT="8080"
```

Turn the judge off for this phase, so we isolate Tier A behaviour before adding
seconds of latency:

```powershell
$env:DLP_JUDGE_PROVIDER=""; $env:DLP_JUDGE_BASE_URL=""; $env:DLP_JUDGE_API_KEY=""
```

```powershell
npm start
```

Check the banner says:

```
mode        observe  (detect and log only - nothing is altered or blocked)
upstream    https://api.anthropic.com
```

Open <http://localhost:8080> on a second monitor if you have one.

### Terminal 2 — Claude Code

```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:8080"
```

```powershell
cd C:\some\scratch\project
```

```powershell
claude
```

Then just work normally for ten minutes. Ask it to read files, explain code,
make a small change. The more ordinary the session, the better the data.

### What to watch

- **The dashboard** — every request, what was detected, what enforcement *would*
  have done (`wouldHave`), and latency.
- **The gateway console** — passthrough lines for endpoints that are proxied
  rather than inspected.
- **`data/audit.jsonl`** — the durable record. `curl http://localhost:8080/api/audit/verify`
  confirms the chain is intact.

---

## What to expect

These are predictions. Write down what actually happens and compare — that is
the difference between an experiment and a demo.

### The gateway should not break anything

Claude Code calls more than one endpoint. Token counting and model listing are
proxied through untouched by the catch-all. If the agent fails to start or hangs,
that is a real bug and the most valuable result of the test.

### Tier A will produce false positives. Specifically:

| Detector | Why it will fire on ordinary code | Genuine? |
|---|---|---|
| `saudi_national_id` | **Unix timestamps.** Epoch seconds are currently 10 digits starting with `17`, and roughly one in ten passes the Luhn check by chance. Any log line or `created_at` field is a candidate. | No |
| `high_entropy_secret` | `package-lock.json` integrity hashes (`sha512-` + base64), minified bundles, long mixed-case identifiers. | No |
| `email` | `package.json` author fields, git config, comments, changelogs. | Usually not |
| `internal_hostname` | Anything matching `*.local`, `*.prod`, `*.internal` in configs, docker-compose files, test fixtures. | Sometimes |
| `private_ip` | `127.0.0.1` is excluded, but `10.x` / `192.168.x` in configs and docs are not. | Sometimes |
| `password_assignment` | `password:` in test fixtures, seed data, example configs. | Sometimes |
| `watchlist` | Only if your project happens to contain the configured terms. | By definition |

The timestamp case is measured, not guessed: **exactly 10.0% of Unix epoch
seconds in the current era pass the Saudi ID checksum** (341,247 of 3,409,298
tested across a four-year window). A bare ten-digit number in a JSON field is not
a national ID, but Tier A has no way to know that. **Context is what separates
them, and Tier A has none.** That is an argument for the two-tier design, not
against it.

### A dry run, before you run anything live

Tier A scanned 39 files of this project's own source — 259 KB of ordinary code,
excluding the benchmark corpus, which is deliberately full of fixtures:

```
  70  high_entropy_secret    e.g. package-lock.json: anthropic-ai/sdk/-/sdk-0...
  38  watchlist              e.g. judge.js: Saned
  21  email                  e.g. demo-client.js: a.alotaibi@example.com.sa
  16  saudi_national_id      e.g. README.md: 1098765439
   8  password_assignment    e.g. config.js: process.env.DLP_JUDGE_API_KEY
   7  internal_hostname      e.g. README.md: llm.internal
   3  anthropic_key / payment_card / iban / saudi_phone / connection_string
  ---
 172  total findings
```

Most of those are this project's own test fixtures finding themselves, which is
a good sign. But two are genuine specification bugs, and they will appear in
*any* codebase:

1. **`high_entropy_secret` fires on `package-lock.json`** — npm registry URLs and
   integrity hashes are long, mixed-case and base64-shaped. 70 of 172 findings,
   41% of everything, from one file that contains no secrets at all.
2. **`password_assignment` fires on code that *reads* a key** — `apiKey:
   process.env.DLP_JUDGE_API_KEY` matches, because the pattern sees
   `api_key:` followed by six-plus characters. Flagging the *name* of a
   credential as the credential is wrong in a way that would make the tool
   unusable on any real repository.

Expect both in your session. They are the first things to fix after this test.

### Latency should be invisible

With the judge off, Tier A is well under a millisecond. Any latency you feel is
the network to Anthropic, not the gateway. If you *can* feel it, something is
wrong and worth investigating.

---

## Phase 2 — turn the judge on

Once Phase 1 is understood, restart the gateway with the judge configured:

```powershell
. .\scripts\demo-env.ps1
```

```powershell
$env:DLP_MODE="observe"; $env:DLP_UPSTREAM_MODE="live"
```

```powershell
npm start
```

### What to expect now

- **The first turn is slow** — the agent's system prompt is large and entirely
  new, so the judge reads all of it. Expect several seconds.
- **Later turns should be much faster.** The system prompt does not change, so
  it is cached after turn one; only new messages reach the model. Watch the
  cache hit rate climb. If it does not, the cache is not working on real traffic
  and that is a finding.
- **Semantic false positives will differ from Tier A's.** The judge sees code and
  may read ordinary engineering discussion as `vulnerability` — we already saw it
  do that with the `HSM` and `VPN tunnel` cases on the corpus.

This phase costs real money per turn. Watch your OpenRouter usage.

---

## Phase 3 — WSL, for the network hop

Native mode proves the pipeline; WSL proves it works across a machine boundary,
which is closer to the VDI story the product is actually about.

The gateway already listens on all interfaces. Two things change:

**1. Find the Windows host from inside WSL:**

```bash
export ANTHROPIC_BASE_URL="http://$(ip route show default | awk '{print $3}'):8080"
```

On Windows 11 with mirrored networking mode, plain `http://localhost:8080` works
and you can skip this.

**2. Windows Firewall will probably block it.** WSL traffic arrives as inbound
on the host. In an **administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DLP gateway (WSL)" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

Remove it when you are done:

```powershell
Remove-NetFirewallRule -DisplayName "DLP gateway (WSL)"
```

Verify connectivity before starting the agent:

```bash
curl -s http://$(ip route show default | awk '{print $3}'):8080/health
```

You want `{"ok":true,...}`. If it hangs, it is the firewall.

---

## What to record

For the pitch, the numbers worth having are:

1. **Requests observed**, and how many raised at least one finding.
2. **False positive rate on real traffic** — go through the dashboard and mark
   each finding genuine or not. This is the number that does not exist yet, and
   it matters more than anything measured on the corpus.
3. **Which detectors were noisiest**, ranked.
4. **Latency added**, p50 and p95.
5. **Cache hit rate** after a long session.
6. **Anything that broke.**

A finding that the gateway is too noisy for enforcement on developer traffic is
a *good* result. It tells you monitor-mode-first is the right rollout, which is
what real DLP vendors do anyway — and it points at the next piece of work:
per-context policies, so a repository full of code is not judged by the same
rules as a customer support ticket.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Claude Code hangs on start | Gateway not running, or wrong port. Check `curl http://localhost:8080/health`. |
| `401` from the gateway | Live mode with no credential. Claude Code should pass its own; check the console. |
| Dashboard empty | It only renders inspected requests. Passthrough-only traffic appears in the console instead. |
| Everything is flagged | Expected on source code. That is the experiment, not a bug. |
| Gateway crashes mid-session | Note the stack trace — that is the most valuable bug this test can produce. Unset `ANTHROPIC_BASE_URL` and carry on. |
| WSL cannot reach the host | Firewall rule, above. |
