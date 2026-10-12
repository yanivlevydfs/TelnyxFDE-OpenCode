# FlyTLV Travel Line — Walkthrough (short) deck

The slide text and short speaker notes for the **9-slide** short version of the Live
Walkthrough & Decision Review defined in
[docs/challenge/code_challenge.md](../challenge/code_challenge.md) (Demo Day, part 2).
Built by **OpenCode** as build step 24 (then revised in steps 24b/24c); every fact
comes from the repo. The rendered HTML is in `deck-short/slides/*.html`; this file
mirrors its text and notes, one slide per section.

Audience: Telnyx engineers. The live demo itself follows
[DEMO_SCRIPT.md](DEMO_SCRIPT.md) and is not part of this deck.

## Timing plan

`cover 30s · arch 50s · workflow 60s · mcp 50s · dynvars 50s · state 60s · bug 70s · opencode 60s · next 50s — about 8 minutes, then Q&A.`

## Slide 1 - FlyTLV Travel Line (cover)

- Phone: **+972 76 567 1113** — bought and linked; regulatory approval pending.
- Webhook · Python 3.9 Edge Function: `fde-webhook-e5907143-e.telnyxcompute.com`
- MCP server · TypeScript Edge Function: `fde-mcp-bc3393fa-a.telnyxcompute.com`
- Session actor · TS Stateful Actors: `fde-session-actor-94b99eb9-4.telnyxcompute.com`
- `ASSISTANT_MODEL = zai-org/GLM-5.3-Flash`
- Why: Tel Aviv fares move fast — a thirty-second call beats browsing.

Notes:
A caller dials the line, asks for cheap flights from Tel Aviv, hears the best
deals from the live flytlv.app feed, saves one, and on the next call hears
"welcome back, you saved …". Three Edge services are live: the webhook (Python
3.9), the MCP server (TypeScript), and the session actor (TypeScript Stateful
Actors). The assistant talks on zai-org/GLM-5.3-Flash (ASSISTANT_MODEL) over
Telnyx Inference. The phone number is bought and linked but Telnyx regulatory
approval is pending; the Portal browser test call is the demo call path.

## Slide 2 - Architecture

Bindings and hops:

- webhook (Python 3.9) → KV: `client.storage.kvs.keys.*` (REST)
- webhook (Python 3.9) → actor: HTTP facade `POST /actors/{digits}/{method}`
- mcp-server (TS) → KV: `env.KV` binding (cache + session)
- mcp-server (TS) → actor: RPC `env.SESSIONS.idFromName(digits)`
- session-actor (TS) → `env.ITINERARIES`: Cloud Storage bucket (5-object cap)

- Three actor classes: **CallerSession**, **MetricsCounter**, **AuditLog** — all
  hosted by session-actor.
- Cloud Storage: one bucket, 5 keys max — 4 `itineraries/slot-<n>.html` + one
  `audit/latest.json`.
- Python webhook cannot bind actors → HTTP facade. TypeScript MCP ships no actor
  code → RPC via `SESSIONS`.

Notes:
The Python webhook cannot bind actors, so it reaches the session-actor through
its HTTP facade (POST /actors/{digits}/{method} with a Bearer token). The
TypeScript MCP server skips that hop: it binds CallerSession directly via the
env.SESSIONS shared-actor binding (no class code shipped; the runtime forwards
over RPC). The session-actor service hosts three actor classes — CallerSession,
MetricsCounter, and AuditLog — and writes to one Cloud Storage bucket hard-capped
at 5 objects: four itinerary slot keys plus one audit/latest.json.

## Slide 3 - Workflow & Edges

Nodes (12):

- speak(4): `greeting`, `degraded_notice`, `deals_disabled`, `farewell`
- prompt(7): `identify_intent`, `search_flights`, `save_deal`, `list_saved`,
  `answer_faq`, `transfer_call`, `timeout_escalate`
- tool(1): `hangup_call`

Expression edges (variable, operator, value):

- `backend_degraded == "true"` → `degraded_notice`
- `flag_deals_enabled == "false"` → `deals_disabled`
- `telnyx_conversation_duration_secs >= 600` → `timeout_escalate`

- `instructions_mode`: **append** (default); **replace** on `timeout_escalate`
  + `hangup_call`.
- `validate()`: start node exists; no duplicate ids; edge targets known;
  condition ∈ {llm, expression, default}; each speak node = exactly 1 default edge.
- Edge counts: 3 expression, 19 LLM, 4 default. Declaration order is priority —
  expression wins over LLM at `identify_intent`.

Notes:
The three expression edges are variable comparisons written in flow.py:
backend_degraded == "true", flag_deals_enabled == "false", and
telnyx_conversation_duration_secs >= 600. Declaration order is priority order,
so expression edges win over LLM edges at the identify_intent hub.
instructions_mode defaults to append; only timeout_escalate and hangup_call use
replace to keep the model tightly on task. validate() checks the graph
statically: start node exists, no duplicate ids, all edge targets are known, the
condition type is valid, and every speak node has exactly one default edge.

## Slide 4 - MCP server

Tool input fields:

- `search_deals`: trip_type, destination, country, weekend, departure_date,
  departure_weekday, min_nights, max_nights, max_price, min_discount_pct,
  direct_only, max_layover_hours, time_of_day, sort
- `save_deal`: deal_id
- `list_saved_deals`: (none)
- `send_deal_sms`: deal_id

- `StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})`
  — fresh per request. Bearer `MCP_API_KEY` checked before the transport.
- `params._meta.telnyx_conversation_id` → KV `session/<conv_id>` → `entity_id` →
  `env.SESSIONS` (phone never in tool args).
- flytlv: `GET /api/private/deals` · `X-API-Key` · 3000 ms + 1 retry.
- `bookable()`: hides flights leaving < 3 h (`MIN_HOURS_BEFORE_DEPARTURE`).
- `weekendDates("upcoming"|"following")` → Thu/Fri/Sat dates by server.
  `inCountry` filters by English name or ISO code.
- Failures → `{isError: true}` with a caller-friendly message, never a traceback.

Notes:
A fresh McpServer + stateless StreamableHTTPServerTransport (sessionIdGenerator:
undefined, JSON responses) is created per request since Edge has no request
lifespan. Bearer MCP_API_KEY is checked in handleRequest before the transport.
Each tool resolves the caller from params._meta.telnyx_conversation_id → KV
session/<conv_id> entity_id → env.SESSIONS actor, so phone numbers never appear
in tool arguments. The flytlv client sends X-API-Key on every GET, times out at
3000 ms with one retry, and drops flights leaving within 3 hours via bookable();
weekend dates are computed server-side and country filtering runs after the
fetch.

## Slide 5 - Dynamic Webhook Variables

Response shape (strings only):

```
{"dynamic_variables": {
  caller_known, call_count, saved_count, last_saved_deal,
  backend_degraded, flag_deals_enabled, flag_sms_enabled, flag_promo}}
```

- Signature: `client.webhooks.unwrap(body, headers)` BEFORE `json.loads`. Bad
  signature → 401; bad JSON → 400.
- Parallel: `_flags(kv)` ∥ `actor.call(entity, "recordCall")` under
  `WEBHOOK_BUDGET_MS` (2500) < `WEBHOOK_TIMEOUT_MS` (8000).
- Safe defaults: on failure, `backend_degraded="true"`, caller_known=false,
  call_count=0; session KV write runs AFTER the response.
- Expression edges route on `backend_degraded` → `degraded_notice`;
  `flag_deals_enabled="false"` → `deals_disabled`.

Notes:
The webhook verifies the Ed25519 signature with client.webhooks.unwrap before
parsing JSON — an unsigned body never reaches json.loads. _fetch_context runs
_flags(kv) and actor.recordCall in parallel under WEBHOOK_BUDGET_MS (2500 ms),
below the assistant's dynamic_variables_webhook_timeout_ms (8000 ms). On any
actor or KV failure the reply keeps safe defaults with backend_degraded="true",
which routes the call to a scripted degraded notice instead of reading raw
placeholders on air.

## Slide 6 - State

| State / key | Primitive | Why |
| --- | --- | --- |
| `flags/assistant` | KV (cached 60 s) | Read-mostly, operator-set; no redeploy |
| `cache/deals/<sig>` (TTL 300) | KV + TTL | Skip repeat flytlv calls |
| `session/<conv>` (TTL 3600) | KV + TTL | Phone stays out of LLM args |
| Per-caller + reminder | CallerSession `idFromName(digits)` | Atomic RMW; `setAlarm` reminder |
| Service counters | MetricsCounter (`"global"`) | Concurrent increments; KV would lose some |
| Audit + itinerary | AuditLog → `audit/latest.json` (200) + 4 slots | Singleton; 4+1 = 5 keys (bucket cap) |

CallerSession storage keys: `callCount`, `lastResults`, `savedDeals`,
`pendingReminder`, `searchHistory`, `itineraryToken`.

Proof: 20 concurrent recordCall → counts 1-20, none lost (live, today).

Notes:
Pick the cheapest primitive that is correct: KV for read-mostly flags, caches
and the one-write session map (which keeps the phone number out of the LLM's
arguments). The CallerSession actor wins for per-caller read-modify-write with
setAlarm for the reminder; MetricsCounter for concurrent service counters. The
AuditLog singleton actor overwrites audit/latest.json (last 200 events) and
shares the one Cloud Storage bucket with 4 itinerary slot keys — 4 + 1 = 5
objects, never growing. Proven by 20 concurrent recordCalls returning counts 1
to 20 with none lost.

## Slide 7 - The hardest bug

- Signal: `{"level":"WARNING","event":"itinerary_skipped","reason":"noITINERARY_BASE_URL"}`
- Root cause: umbrella `telnyx.toml [env_vars]` never reach actor `process.env`
  (step 11). Cloud Storage binding does.
- Fix: `config.X ?? process.env.X` — MCP forwards config on `saveDeal`.
- Evidence: `itineraryUrl` returns, `reminder_scheduled` fires; `check_itinerary`
  with no `process.env` passes.
- **TooManyObjects**: bucket 5-object cap hit while `live_check` stayed green →
  4 slot keys + `audit/latest.json`; `storage_check` guards it.

Notes:
The signal was one JSON log line — itinerary_skipped with reason
noITINERARY_BASE_URL. Root cause: the actor's umbrella telnyx.toml [env_vars] do
not reach actor instances' process.env while the Cloud Storage binding does. Fix:
the MCP server forwards config on every saveDeal call and the actor resolves
config.X ?? process.env.X. A second silent failure (TooManyObjects) hit the
bucket's 5-object cap while live_check stayed green; fixed by only writing 4
slot keys plus one audit/latest.json. A third bug (commit 11bff7e) was every call
degraded by slow KV (1.2-3.7 s per REST read); fixed by caching flags, running
the session write after the response, and raising the webhook budget to 2500 ms.

## Slide 8 - Building with Telnyx Inference via OpenCode

- Command: `opencode run --model 'telnyx/zai-org/GLM-5.2' "<prompt>"`
- Cost env: `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`
  (clean XDG config dir) → 215k → 8.7k tokens/req.
- Models per part:
  - **GLM-5.2**: shared, MCP server, assistant flow, session actor, docs.
  - **Kimi-K3**: webhook v1.
  - **GLM-5.3-Flash**: `ASSISTANT_MODEL` — LLM on calls.
- Step loop: prompt in PROMPTS.md → OpenCode → tests → review → commit.
- Attribution: OpenCode with Telnyx models built the first version of every
  service (GLM-5.2; Kimi-K3 for the webhook); since 7 Oct every change is an
  OpenCode build step (`docs/build/PROMPTS.md`).

Notes:
opencode run --model telnyx/zai-org/GLM-5.2 runs each build step. Global context
blew requests to ~215k tokens until OPENCODE_DISABLE_EXTERNAL_SKILLS=1 with a
clean XDG config dir cut it to ~8.7k.
Models per part: GLM-5.2 for shared code, MCP server, assistant flow, session actor and docs;
Kimi-K3 for webhook v1; GLM-5.3-Flash as ASSISTANT_MODEL
(the assistant's LLM on calls). Each step follows the loop in PROMPTS.md: write
the prompt, run OpenCode, run tests, review, commit.

## Slide 9 - Edge cases and next steps

Edge cases (with status codes / behaviour):

- bad signature → 401; bad JSON → 400
- KV/actor fail → `backend_degraded="true"` → `degraded_notice`
- flytlv 3000 ms + 1 retry (TimeoutError only)
- `flag_deals_enabled="false"` → `deals_disabled`
- MCP fail → `{isError: true}` with caller-friendly message
- `send_deal_sms` → `+<digits>` (own number); deal ∈ lastResults

- **Shipped:** transfer tool (TRANSFER_TO_NAME), 23-entry FAQ, SMS deal link, KV
  read retry, live_check 23 checks, storage_check, metrics.py, CI per service,
  Israel logs.
- **Stretch:** actor alarms, Cloud Storage itinerary, KV flags, shared actors,
  trace_id, variable edges; caller history (searchHistory, insights, history.py).
- **Next:** per-deal reminders via CronTick actor (today: one alarm/caller);
  flight-status branch.

Questions?

Notes:
Edge cases handled by the code: a bad webhook signature returns 401 before JSON
is parsed, bad JSON returns 400, and any KV or actor failure sets
backend_degraded="true" which routes to a scripted degraded_notice. flytlv times
out at 3000 ms with one retry on TimeoutError; the deals_enabled=false flag
routes to deals_disabled; MCP tool failures return isError:true with a
caller-friendly message; send_deal_sms only texts the caller's own number and
only for a deal in lastResults. Shipped extras include the transfer tool (live),
a 23-entry FAQ with no invented baggage or booking facts, KV read retry,
live_check with 23 checks, storage_check, and Israel-time logs. Two true next
items: per-deal reminders via a CronTick actor (currently one alarm per caller)
and a flight-status branch.

## Sources — which long-deck slide each short slide condenses

- Slide 1 (cover): cover.html + one line from why.html.
- Slide 2 (arch): arch.html (bindings + hops + actor classes + Cloud Storage).
- Slide 3 (workflow + edges): workflow.html + edges.html merged; node ids, expression edges, validate() in one.
- Slide 4 (mcp): mcp.html (four tools, transport, caller resolution, flytlv).
- Slide 5 (dynvars): dynvars.html (response shape, parallel budget, safe defaults).
- Slide 6 (state): state.html — six rows incl. reminder and audit + storage keys.
- Slide 7 (bug): bug.html (JSON signal, config fix, TooManyObjects, slow KV).
- Slide 8 (opencode): opencode.html (command, cost env, models per part, step loop).
- Slide 9 (next + edge cases): next.html + stretch.html merged; edge cases with codes, shipped extras, stretch + history, next items.
  Dropped on purpose into the live demo or Q&A: sequence, flowgraph, edges (merged),
  saveflow, stretch (merged), observe, trace, history, deploy.
