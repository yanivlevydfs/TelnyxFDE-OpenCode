# FlyTLV Travel Line — Walkthrough (short) deck

The slide text and short speaker notes for the **9-slide** short version of the Live
Walkthrough & Decision Review defined in
[docs/challenge/code_challenge.md](../challenge/code_challenge.md) (Demo Day, part 2).
Built by **OpenCode** as build step 24 by condensing and reusing the long deck
(`docs/presentation/deck/slides/`); every fact comes from there. The rendered HTML is in
`deck-short/slides/*.html`; this file mirrors its text and notes, one slide per section.

Audience: the Telnyx FDE team. The live demo itself follows
[DEMO_SCRIPT.md](DEMO_SCRIPT.md) and is not part of this deck.

## Timing plan

`cover 30s · arch 50s · workflow 60s · mcp 50s · dynvars 50s · state 60s · bug 70s · opencode 60s · next 50s — about 8 minutes, then Q&A.`

## Slide 1 - FlyTLV Travel Line (cover)

- Cheap flights from Tel Aviv by phone, round trip or one way.
- Phone: **+972 76 567 1113** — bought and linked; regulatory approval pending.
- Webhook: https://fde-webhook-e5907143-e.telnyxcompute.com
- MCP server: https://fde-mcp-bc3393fa-a.telnyxcompute.com
- Session actor: https://fde-session-actor-94b99eb9-4.telnyxcompute.com
- Why: Tel Aviv fares move fast — a thirty-second call beats browsing.

Notes:
A caller dials, asks for cheap flights from Tel Aviv, hears the best deals from the live
flytlv.app feed, can save one, and on the next call hears "welcome back, last time you
saved Larnaca, 64 dollars." Regulatory approval is still pending, so the live demo uses
the Portal browser test call. Three Edge services are live: webhook, MCP server, and
the session actor.

## Slide 2 - Architecture

- Caller → AI Assistant (Conversation Workflow, 12 nodes).
- Call start: webhook (Edge Function, Python) runs once — KV flags plus recordCall.
- Mid-call: mcp-server (Edge Function, TypeScript, 4 tools) — KV cache + flytlv API + the same caller actor via shared SESSIONS.
- session-actor (Stateful Actor, TypeScript) holds per-caller state.
- KV keeps flags · cache · session; the flytlv deals API is the external source.

Notes:
At call start the workflow fires the webhook once, which reads flags from KV and records
the call on the caller's actor. Mid-conversation, the prompt nodes call the MCP server,
which reads the KV cache, calls flytlv, and reaches the same actor directly through the
shared SESSIONS binding. The Python webhook cannot bind actors, so it uses the HTTP
facade; the TypeScript MCP server skips that hop.

## Slide 3 - Workflow & Edges

Nodes (12):
- 4 speak: greeting, degraded, deals_disabled, farewell — verbatim, no model turn.
- 7 prompt: identify, search, save, list, FAQ, escalate, transfer — every LLM step.
- 1 tool: hangup_call — deterministic end; no prompt node hangs up.

Edges (26):
- 3 expression: deterministic facts, checked before the model turn.
- 19 LLM: intent routing, where the caller's words vary.
- 4 default: one per speak node, enforced by validate().

Tradeoff: expression edges route on facts before the model turn (safer); LLM edges route
on intent where words vary (more flexible).

Notes:
Speak nodes are verbatim with no model turn; prompt nodes are every LLM-driven step; the
one tool node ends the call deterministically. Expression edges are deterministic facts
checked before the model turn; LLM edges handle intent where the caller's words vary.
Declaration order is priority order, so expression edges win over LLM edges at the
identify_intent hub.

## Slide 4 - MCP server

- Four tools, each backed by the caller's actor:
  - `search_deals`: KV cache, then flytlv. Stores results on the actor.
  - `save_deal`: Actor saveDeal — itinerary page and reminder alarm.
  - `list_saved_deals`: Actor getSaved — reads back what the caller kept.
  - `send_deal_sms`: Texts a saved deal. Off when sms_enabled is false.
- Official `@modelcontextprotocol/sdk`; a fresh stateless transport per request.
- Bearer `MCP_API_KEY` is checked before the transport; failures return `isError: true`, never a traceback.
- MCP tools can't be scoped per node, so each prompt node's text names its one tool.

Notes:
Four tools, each backed by the caller's actor: search writes the results; save writes a
page and schedules a reminder; list reads back saved ones; send texts a saved deal when
SMS is on. We use the official SDK with a fresh stateless
`StreamableHTTPServerTransport` per request, since Edge has no request lifespan. Tools
can't be scoped per workflow node, so each prompt node's text names its one tool and the
server enforces safety itself; failures return `isError: true`, never a traceback or URL.

## Slide 5 - Dynamic Webhook Variables

Returned (strings only): `caller_known`, `call_count`, `saved_count`, `last_saved_deal`,
`backend_degraded`, `flag_<name>`.

- Personalises: "Welcome back, last time you saved Larnaca for 64 dollars."
- Routes: `backend_degraded` and `flag_deals_enabled` drive the expression edges.
- Stays fast: assistant timeout 8000 ms; webhook budget 2500 ms; `backend_degraded=true` on failure.

Notes:
The webhook overrides the assistant's default variables at call start; if it fails
entirely the defaults keep expression edges from comparing against raw placeholders. The
assistant timeout is 8000 ms and the webhook keeps an internal 2500 ms parallel budget
— the session write even runs after the response. On any actor or KV failure it
returns `backend_degraded=true`, which routes the call to a scripted notice instead of
reading placeholders on air.

## Slide 6 - Actor vs KV vs plain function logic

| State | Primitive | Why |
| --- | --- | --- |
| Feature flags | KV | Read-mostly, operator-set; no redeploy |
| Deal search cache | KV + TTL | Skip repeat flytlv calls; seconds-stale is fine |
| Conversation → caller | KV + TTL | One write by webhook, read by MCP; phone stays out of LLM args |
| Per-caller: count, results, saved, history | Stateful Actor | Atomic read-modify-write; KV has no CAS |
| Service counters, latency | MetricsCounter Actor | Concurrent increments; KV would lose some |
| Itinerary page | Cloud Storage | Slot key, `/itineraries/<slot>-<token>.html`; ≤5 keys |

Proof: 20 concurrent recordCall requests return counts 1 to 20, none lost (live, today).

Notes:
Pick the cheapest primitive that is correct: KV for read-mostly flags, caches and the
one-write session map (which keeps the phone number out of the LLM's arguments). The
actor wins for per-caller read-modify-write, proven by 20 concurrent recordCalls
returning counts 1 to 20 with none lost. The itinerary lives in Cloud Storage at a
fixed slot key because the bucket is hard-capped at 5 objects; the reminder and audit
use actor storage and a singleton AuditLog actor.

## Slide 7 - The hardest bug

- Symptom: on save, the itinerary URL and the SMS reminder never appeared.
- Signal: `itinerary_skipped reason=noITINERARY_BASE_URL` on every save.
- Root cause: umbrella `telnyx.toml [env_vars]` never reach actor `process.env`. The Cloud Storage bucket binding does.
- Fix: MCP forwards config on `saveDeal`; the actor reads `config` first, `process.env` as fallback.
- Evidence: `itineraryUrl` returns, `reminder_scheduled` fires, a check with no `process.env` passes.

Second silent failure: the bucket's 5-object cap (`TooManyObjects`) hit while `live_check`
stayed green; found in actor logs; fixed with 4 slot keys + one `audit/latest.json`;
`storage_check.py` guards the limit.

Notes:
The value was set in the actor's umbrella `telnyx.toml` but the actor instance never saw
it — while the Cloud Storage bucket binding did, and the MCP function's own env did.
So the MCP server now forwards the values on every `saveDeal` call and the actor resolves
`config` first with `process.env` as a fallback. A second silent failure: the same bucket
is hard-capped at 5 objects, writes failed with `TooManyObjects` while `live_check` stayed
green — fixed by writing only 4 slot keys and one `audit/latest.json`.

## Slide 8 - Building with Telnyx Inference via OpenCode

- Models used: GLM-5.2 (wrote most of the code and docs), Kimi-K3 (the first webhook version), GLM-5.3-Flash (the assistant's voice on calls).
- Worked: test-first prompts passed the acceptance tests in few iterations; multi-file work, including the MCP port from Python to TypeScript.
- Hurt: credit stops mid-step (error 20015); global context blew requests to 215k, cut to 8.7k.
- Edge specifics surfaced only on deploy: Python 3.9 build, health probes, the bucket 5-object cap.

Notes:
Test-first prompts against the acceptance tests plus the short rules file produced
passing code in a few iterations, and GLM-5.2 handled multi-file work well, including the
MCP port from Python to TypeScript. What hurt: a negative balance stops inference mid-step
with error 20015, and global context blew requests up to 215k tokens until a clean
config dir cut it to 8.7k. Platform specifics — the Python 3.9 build, the health probes,
and the Cloud Storage 5-object cap — only surfaced on deploy and were fixed there, from
actor logs.

## Slide 9 - Tradeoffs, edge cases and next steps

- Tradeoff: expression edges for facts (safer, less flexible); actor for read-modify-write, KV for read-mostly.
- Tradeoff: shared actor skips HTTP; the facade stays for Python and for metrics.
- Edge cases: degraded backend routes to a scripted notice; bucket capped at 5 keys; config forwards to the actor.
- Next: link the human transfer number; add a flight-status branch.
- Next: per-deal reminders via a CronTick actor — the one-alarm-per-caller limit means one reminder per caller, not per deal.

Questions?

Notes:
Expression edges for facts are safer but less flexible; the actor wins for read-modify-write,
KV for read-mostly data; the shared actor skips HTTP while the facade stays for Python and
metrics. Edge cases are handled safe by design: a degraded backend routes to a scripted
notice, the bucket is capped at 5 keys, and config now forwards to the actor. Next I would
link the human transfer number, add a flight-status branch, and move reminders to a
CronTick actor for per-deal scheduling.

## Sources — which long-deck slide each short slide condenses

- Slide 1 (cover): cover.html + one line from why.html.
- Slide 2 (arch): arch.html (three services + KV + flytlv API; detail dropped).
- Slide 3 (workflow + edges): workflow.html + edges.html merged; LLM vs expression tradeoff in one line.
- Slide 4 (mcp): mcp.html (four tools and the server shape).
- Slide 5 (dynvars): dynvars.html (dynamic webhook variables).
- Slide 6 (state): state.html — the six most important table rows.
- Slide 7 (bug): bug.html (the hardest bug and the signal that found it).
- Slide 8 (opencode): opencode.html (the models used, plus worked / hurt condensed).
- Slide 9 (next + stretch): next.html + stretch.html merged into five bullets.
  Dropped on purpose into the live demo or Q&A: sequence, flowgraph, edges (merged),
  saveflow, stretch (merged), observe, trace, history, deploy.
