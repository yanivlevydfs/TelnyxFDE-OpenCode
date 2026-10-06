# FlyTLV Demo Script (Live Demo, 8–10 min)

Run-of-show for the **Live Demo** portion of Demo Day as defined in
[code_challenge.md](../code_challenge.md). A caller phones the FlyTLV line,
asks for cheap flights to Cyprus, hears the best deals from the live
`flytlv.app` feed, saves one, and on the next call hears "Welcome back, last
time you saved Larnaca for 64 dollars." Everything runs on Telnyx Edge
(webhook + MCP server + Stateful Actor), edge functions deployed with
`telnyx-edge ship`.

The demo must visibly hit all five required elements (workflow, MCP, dynamic
webhook, Edge/KV/Actor, observability). The script is timed to ~9 minutes with
buffer for live conversation.

## Two screens, side by side

- **Left:** a phone dialling the assistant (or the Telnyx portal call tester)
  plus a scratchpad of `curl` snippets for the flag-flip beat.
- **Right:** a live log tail in one terminal, so the audience sees every request
  flow through the stack:

```bash
for fn in fde-webhook fde-mcp fde-session-actor; do
  telnyx-edge logs $fn --type runtime --json --tail
done
```

## Pre-flight (before you're on)

- [ ] Env secrets set on Edge (`TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`,
      `KV_NAMESPACE_ID`, `ACTOR_SERVICE_URL`, `INTERNAL_API_TOKEN`,
      `MCP_API_KEY`, `FLYTLV_API_KEY`).
- [ ] The three services are shipped:
      `telnyx-edge ship --from-dir services/webhook`,
      `--from-dir services/mcp-server`, and `cd services/session-actor && telnyx-edge ship`.
- [ ] `python assistant/provision.py` (assistant + workflow + MCP server + phone number) is provisioned
      and a phone number is linked.
- [ ] KV flag `flags/assistant` exists as `{"deals_enabled": true}` (needed for
      the flag-flip beat):
      `telnyx-edge storage kv put flags/assistant '{"deals_enabled":true}'`.
- [ ] Right-screen log tail is running and you can see a test webhook fire
      (= green baseline).
- [ ] Have the OpenCode config + `/telnyx` model list ready for the walkthrough.

## The call (two calls, one bug-beat)

### 0:00–0:30 — Intro ("what it is")

> "This is the FlyTLV Travel Line. People in Israel phone it for cheap
> round-trip flights from Tel Aviv. Behind it: a Telnyx AI Assistant with a
> Conversation Workflow, an MCP server, a Stateful Actor, and KV — all on Edge."

Show the [architecture diagram](../README.md#architecture): the chain
**Assistant → Workflow → Edge Function → KV/Actor → MCP** is the demo.

### 0:30–1:15 — First call: greeting = speak node + dynamic webhook

**Dial the number.** The assistant speaks the verbatim greeting:
"Welcome to the FlyTLV Travel Line. I'm an AI assistant. I can find you cheap
round-trip flights from Tel Aviv, and remember the ones you save. This call may
be recorded for quality."

Call out:
- That is a **speak node** — delivered verbatim, no model turn (compliance).
- Telnyx fired the webhook **once** at call start to fetch dynamic variables.

On the right screen, point at the webhook log:
```
{"level":"info","event":"span","trace_id":"<conv-id>","span":"webhook.request",
 "duration_ms":212,"outcome":"ok","caller":"***0100","degraded":[]}
```
The `trace_id` is the conversation id — it will carry all the way to the actor
and the MCP server. *Dynamic webhook: requirement 4a/3.*

### 1:15–3:30 — Search flights = workflow routing + MCP tool call

Say: **"Something cheap to Cyprus in November."**

What the audience sees happen:
1. `identify_intent` (prompt node) routes on an **llm edge** ("caller wants to
   search for cheap flights") → `search_flights`.
2. `search_flights` (prompt node) calls the **`search_deals` MCP tool**.

Point at the right screen:
- `mcp.search_deals` INFO span with the same `trace_id` — an **MCP tool call**
  mid-conversation (*MCP integration: requirement 2*).
- KV `cache/deals/<...>` miss → real `GET flytlv.app/api/private/deals`
  (X-API-Key) → cache write (*Edge/KV: requirement 4b*).
- The actor's `setLastResults` line — the deals read aloud are stored on the
  caller's actor so a later save can't invent one (*Actor: requirement 4c*).

The assistant reads back 2–3 deals:
"Larnaca, Wizz Air, direct, November 9 to 12, sixty-four dollars. Paphos,
Ryanair, one stop, November 14 to 18, eighty-seven dollars. Want me to save one?"

> Multi-step workflow (greeting → identify → search), MCP tool, KV cache and
> actor write all on screen in one `trace_id`. *Workflow: requirement 1.*
> *Edge in action: requirement 4.*

### 3:30–4:30 — Save a deal = actor read-modify-write

Say: **"Save the first one."**

- `save_deal` (prompt node) → `save_deal` MCP tool → actor `saveDeal`.
- Point at the `saveDeal` log: `savedCount` increments, `lastSaved` becomes the
  shown deal.
- Note this is the read-modify-write the actor exists for: KV has no
  compare-and-set, so two concurrent calls from one caller would race — the
  actor serializes the write (*why Actor vs KV*).

"Saved. Next time you call, I'll remind you." Hang up.

### 4:30–6:00 — Second call: "Welcome back" = the whole chain, personalized

**Redial from the same number.** The greeting + identify step now says:
"Welcome back — last time you saved Larnaca for 64 dollars."

Show on the right screen how that one sentence is built:
- Webhook fire → `recordCall` on the same actor instance → `callCount` 2,
  `lastSaved` = the saved Larnaca deal.
- The webhook turns that into `last_saved_deal = "Larnaca, 64 USD"` and
  `caller_known = "true"` dynamic variables.
- The `identify_intent` prompt interpolates them into the welcome-back line.

> Dynamic webhook personalized the greeting from per-caller state —
> the actor (typed state) → KV session map → webhook → workflow.
> *Dynamic Variables influencing the conversation: requirements 3 & 4a.*

### 6:00–7:00 — Edge Compute in action (point at the platform)

Pin the three deployed functions in the portal / CLI:
- `fde-webhook` — `https://fde-webhook-<id>.telnyxcompute.com`
- `fde-mcp` — `https://fde-mcp-<id>.telnyxcompute.com`
- `fde-session-actor` — Stateful Actor on the Edge actor runtime

`telnyx-edge metrics fde-webhook`: show request count, 2xx, p50/p95 — the canary.
Briefly: KV reads/writes against the `fde-kv` namespace, actor storage holds
`callCount` / `lastResults` / `savedDeals`. *Function + KV + Actor, deployed:
requirements 4a, 4b, 4c.*

### 7:00–8:30 — Observability: one trace, end-to-end + the one bug

Pick the conversation id from a line and glue the whole call together:

```bash
for fn in fde-webhook fde-mcp fde-session-actor; do
  telnyx-edge logs $fn --type runtime --json --since 1h
done | jq -c 'select(.trace_id=="<conv-id>")'
```

Walk one beat — `webhook.request` → `recordCall` → `mcp.search_deals` →
`saveDeal` — all under one id, every latency span visible.

**Evidence-driven debugging beat.** Tell one thing that broke during
development and the signal that exposed it (e.g. "[spoiler for build-day] when
the flytlv API key was rejected, the `flytlv.feed_off` ERROR fired exactly once
and the MCP tool returned a `ToolError` with the caller-friendly message; the
webhook logged `backend_degraded` and the workflow's expression edge sent those
calls to `degraded_notice` instead of reading `{{placeholders}}` on air."). Show
the log line. *Observability: requirement 5.*

### 8:30–9:30 — Fallback path: flip a KV flag live = expression edge

Flip the deals feature flag (no redeploy — KV feature-flag stretch):

```bash
telnyx-edge storage kv put flags/assistant '{"deals_enabled":false}'
```

Redial. The webhook reads the new flag and returns `flag_deals_enabled="false"`;
the assistant routes via the **expression edge** to `deals_disabled` (speak
node): "Flight deal search is temporarily turned off. Please call back later."

Explain: that edge is deterministic and evaluated *before* the model turn — a
broken/disabled backend never depends on the model noticing it (decision #12).
Flip the flag back to `true` and a redial returns to the happy path.
*Fallback path + KV feature flag: requirements 5 (happy + fallback) & a
stretch goal.*

### 9:30–10:00 — Close

> "Everything you saw runs on Telnyx: the workflow, the MCP server, the
> Stateful Actor, KV. OpenCode with Telnyx-hosted models (GLM-5.2, Kimi-K3)
> built the first version of every component from the spec and the tests.
> Getting it live on Edge exposed platform bugs the tests couldn't, and those
> fixes and the later features were done with Claude Code. Here's the config,
> and the comparison."

Optional one-liner: show `opencode.json` + the `/telnyx` model list to bridge
into the walkthrough.

## Demo checklist → requirement mapping (keep handy)

| Beat | Requirement shown |
|---|---|
| Greeting (speak node, dynamic webhook) | 1 (speak node), 3, 4a (webhook) |
| "Cheap to Cyprus" → identify_intent llm edge → search_flights | 1 (multi-step workflow, conditional edges) |
| `search_deals` MCP tool on screen | 2 (MCP, ≥3 tools available) |
| KV cache read/write + flytlv call | 4b (KV) |
| `save_deal` → actor `saveDeal` | 4c (Actor read-modify-write) |
| Redial → "Welcome back, you saved Larnaca for 64 dollars" | 3 (dynamic vars personalize) |
| Three deployed Edge Functions + metrics | 4a, 4b, 4c (deployed, public) |
| One `trace_id` across webhook/mcp/actor + the debugging beat | 5 (observability + evidence) |
| KV flag flip → `deals_disabled` speak node | 5 (fallback path) + KV-flag stretch |

After this (7–10 min Live Walkthrough & Decision Review, 5 min Q&A) — be ready
to explain (per `code_challenge.md`):
- The use case and why it fits workflows + a Stateful Actor.
- Node design & edge conditions (speak for verbatim; `expression` for facts
  before the model turn; `llm` for intent; `append` vs `replace` instructions).
- MCP server structure (3 tools, stateless Streamable HTTP per request, bearer
  auth before the manager, `ToolError` to the LLM).
- Why Actor vs KV vs function logic for each piece of state (see
  [README.md](../README.md#why-stateful-actor-vs-kv-vs-plain-function-logic)).
- How OpenCode + Telnyx Inference were used, and which model built each
  component (see
  [README.md](../README.md#which-model-built-each-component)).
- The hardest bug you hit — the signal that exposed it (the observability
  trail), not vibes.
- Edge cases handled: caller hangs up mid-deal, an anonymous caller, a degraded
  backend, re-saving the same deal (dedup), the deals flag off.
