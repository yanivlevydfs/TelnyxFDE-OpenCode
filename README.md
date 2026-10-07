# FlyTLV Travel Line

A phone line for cheap flights from Tel Aviv, round trip or one way. You call a Telnyx AI
Assistant and ask for a deal ("something cheap to Cyprus in November"). It
reads back the 2–3 cheapest deals from the live `flytlv.app` deals API, can
save one, and on your next call says "Welcome back, last time you saved Larnaca
for 64 dollars."

Built for the Telnyx FDE coding challenge ([docs/challenge/code_challenge.md](docs/challenge/code_challenge.md)).
Requirement 6: the first version of every component was built by **OpenCode
powered by Telnyx Inference** from the spec and the acceptance tests. See
[Tool comparison](#tool-comparison) for what each AI coding tool built.

## Documentation

Every Markdown file in the repo, grouped by area, each with a one-line purpose taken from the file itself:

| Area | File | Purpose |
| --- | --- | --- |
| Overview | [README.md](README.md) | FlyTLV Travel Line: cheap flights from Tel Aviv by phone (root overview) |
| Overview | [docs/README.md](docs/README.md) | Documentation index |
| Challenge | [docs/challenge/code_challenge.md](docs/challenge/code_challenge.md) | AI Assistant & Edge Compute coding challenge brief |
| Challenge | [docs/challenge/USE_CASE.md](docs/challenge/USE_CASE.md) | Who the FlyTLV Travel Line is for and the problem it solves |
| Design | [docs/design/ARCHITECTURE.md](docs/design/ARCHITECTURE.md) | Architecture: request path of a call and the components |
| Design | [docs/design/DECISIONS.md](docs/design/DECISIONS.md) | Decision log: alternatives considered and why |
| Design | [docs/design/OBSERVABILITY.md](docs/design/OBSERVABILITY.md) | Observability: signals, log events and how to read them |
| Design | [docs/design/PRODUCT.md](docs/design/PRODUCT.md) | Product brief for Telnyx reviewers and product people |
| Guides | [docs/guides/HOW_TO_CALL.md](docs/guides/HOW_TO_CALL.md) | How a caller talks to the FlyTLV Travel Line |
| Guides | [docs/guides/DEMO_SCRIPT.md](docs/guides/DEMO_SCRIPT.md) | Demo script for the live 8–10 min demo |
| Guides | [docs/guides/INTEGRATION.md](docs/guides/INTEGRATION.md) | Integration & operations guide for engineers |
| Build | [docs/build/PROMPTS.md](docs/build/PROMPTS.md) | Build prompts and step status for OpenCode |
| Build | [docs/build/DOGFOODING.md](docs/build/DOGFOODING.md) | Dogfooding notes: OpenCode + Telnyx Inference |
| Services | [services/webhook/README.md](services/webhook/README.md) | Dynamic Variables webhook (Python Edge Function) |
| Services | [services/mcp-server/README.md](services/mcp-server/README.md) | MCP server exposing the tools the assistant calls mid-conversation |
| Services | [services/session-actor/README.md](services/session-actor/README.md) | CallerSession Stateful Actor: per-caller state, itinerary & alarm |
| Assistant | [assistant/README.md](assistant/README.md) | Assistant definition & provisioning via the Telnyx SDK |
| Shared | [shared/README.md](shared/README.md) | Common Python code, vendored into each Edge Function |
| Scripts | [scripts/README.md](scripts/README.md) | Build and ops scripts, run from the repo root |
| Tests | [tests/README.md](tests/README.md) | Acceptance tests (not edited) plus self-checks |
| AGENTS.md | [AGENTS.md](AGENTS.md) | Instructions for the AI coding agent (OpenCode + Telnyx Inference) |

## Status

| Component | Folder | Built with OpenCode (Telnyx model) | Tests | Deployed |
| --- | --- | --- | --- | --- |
| Shared code | `shared/common.py` | GLM-5.2 (v1) | 13/13 | vendored into each Python service |
| Dynamic Variables webhook | `services/webhook` | Kimi-K3 (v1) | 9/9 | live, `fde-webhook` |
| MCP server (4 tools) | `services/mcp-server` | GLM-5.2 (v1; shared actor — step 8; live config fix — step 11) | 11/11 | live, `fde-mcp` |
| CallerSession + MetricsCounter Stateful Actors | `services/session-actor` | GLM-5.2 (v1; itinerary + alarm — step 7; live config fix — step 11) | 7/7 + check 8/8 | live, `fde-session-actor` |
| Assistant + Conversation Workflow | `assistant/` | GLM-5.2 (v1; flow upgrade — step 9) | 7/7 + check 29/29 | live (`provision.py`) |
| Deploy pipeline | `.github/workflows/ship.yml` | — | — | GitHub Actions |
| Phone number | `+972765671113` (Israel) → TeXML app "FLYTLV ai-assistant" → `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16` | — | — | bought and linked; Telnyx regulatory approval pending (`requirement-info-pending`). Verified 7 Oct 2026 via `GET /v2/phone_numbers`. |

Live checks: `scripts/ops/live_check.py` (20/20 PASS), `scripts/ops/workflow_paths.py`
(every workflow path over the chat API) and `scripts/ops/actor_concurrency_check.py`
(20 concurrent updates, none lost). See [scripts/README.md](scripts/README.md).

Total: **47 tests** (29 Python + 11 MCP + 7 actor) green: `.venv/Scripts/python -m pytest tests -q`,
`cd services/mcp-server && npm test` and `cd services/session-actor && npm test`.

**Live endpoints and phone number**

| What | Where |
| --- | --- |
| Phone | **+972765671113** (Israel) → TeXML app "FLYTLV ai-assistant" → `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16`. Status: bought and linked; Telnyx regulatory approval pending (`requirement-info-pending`). Verified 7 Oct 2026 via `GET /v2/phone_numbers`. (How to talk to it: [docs/guides/HOW_TO_CALL.md](docs/guides/HOW_TO_CALL.md).) |
| Assistant | `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16` — talks on calls with `zai-org/GLM-5.3-Flash` on Telnyx Inference (verified by `GET /v2/ai/assistants/{id}`: model `zai-org/GLM-5.3-Flash`, `external_llm` null); its code (`assistant/flow.py`, `provision.py`) was written by OpenCode with Telnyx `GLM-5.2` |
| Webhook (Edge Function) | https://fde-webhook-e5907143-e.telnyxcompute.com |
| MCP server (Edge Function) | https://fde-mcp-bc3393fa-a.telnyxcompute.com |
| Session actor (Edge) | https://fde-session-actor-94b99eb9-4.telnyxcompute.com |

Deploys run from GitHub Actions ([.github/workflows/ship.yml](.github/workflows/ship.yml)):
the Windows `telnyx-edge` CLI zips paths with backslashes, which breaks multi-folder
functions on the Linux builders.

## Architecture

The challenge's required path is **Assistant → Workflow → Edge Function →
KV/Actor → MCP**. The conversation *workflow* is the orchestrator: at call
start it fires the **dynamic-variables webhook** (an Edge Function) which talks
to **KV** and the **Stateful Actor**; mid-conversation the **prompt tool nodes**
call the **MCP server** (an Edge Function), which itself reads **KV** (cache +
session map), the **flytlv.app** deals feed and the per-caller **Stateful
Actor**. The MCP server calls `CallerSession` through the **shared actor**
`SESSIONS` binding (no HTTP hop — the production path; the HTTP facade is a
`USE_SHARED_ACTOR=false` fallback and is also used for the MCP server's
per-request metrics `POST /metrics/add` to the shared `MetricsCounter`). The
Python webhook can't bind actors, so it uses the HTTP facade for `recordCall`.
When the caller picks a deal the actor also writes a mobile-friendly
**itinerary HTML page** to a Telnyx Cloud Storage bucket (served at
`GET /itineraries/<uuid>.html`) and arms its single actor **alarm** to send a
follow-up SMS `REMINDER_DELAY_SECONDS` later.

```
Caller (phone)
   │
   ▼
Telnyx AI Assistant ── Conversation Workflow  (speak / prompt nodes; default / llm / expression edges)
   │
   ├── 1. call start ─────────────────────────────────────────────────────────────┐
   │       assistant.initialization webhook (once)                                │
   ▼                                                                              │
webhook   (Python Edge Function · fde-webhook)                                    │
   │  ├─ KV  REST: read flags/assistant (feature flags)                          │
   │  └─ HTTP ─┐  recordCall  →  session-actor (TypeScript Edge Function) ◀──────┤
   │           ▼     CallerSession Stateful Actor (one instance per caller)      │
   │           └─ KV REST: write session/<conv_id> → {entity_id} (TTL=1h)        │
   ▼                                                                              │
{"dynamic_variables": {caller_known, call_count, saved_count, last_saved_deal,  │
                        backend_degraded, flag_deals_enabled}}                    │
   │  → greeting text, "welcome back", and expression-edge routing               │
   │                                                                              │
   └── 2. mid-conversation tool calls ──────────────────────────────────────────┘
       (search / save / list tool nodes)
        ▼
mcp-server (TypeScript Edge Function · fde-mcp)
   │  ├─ Bearer auth (MCP_API_KEY)
   │  ├─ KV  env.KV: cache/deals/<sig>  (TTL'd search cache)  +  session/<conv_id> → caller
   │  ├─ HTTP:  flytlv.app  GET /api/private/deals  (X-API-Key)                 ──▶ flytlv feed
   │  ├─ shared actor env.SESSIONS.idFromName(caller)[method] ─▶ CallerSession:
   │  │     setLastResults / saveDeal (returns itineraryUrl) / getSaved  (no HTTP hop)
   │  └─ HTTP ─▶ session-actor /metrics/add  (MetricsCounter actor; fire-and-forget)

session-actor (TypeScript Edge Function · fde-session-actor):
   ├─ HTTP facade POST /actors/{caller}/{method}  (Bearer INTERNAL_API_TOKEN) — webhook only
   ├─ public  GET /itineraries/<uuid>.html        (no bearer; the random UUID is the capability)
   ├─ CallerSession.saveDeal: renders a mobile-friendly itinerary HTML page → Cloud Storage
   │    bucket `flytlv-itineraries` under itineraries/<uuid>.html (reused on a re-save)
   └─ arms the single actor alarm; after REMINDER_DELAY_SECONDS the alarm() override sends
      a follow-up SMS via env.TELNYX.messages.send ("Still thinking about <city> for
      <price> <currency>? Your itinerary: <url>")

Built using:
┌─────────────────────────────────────────────────────────────┐
│         OpenCode + @telnyx/opencode plugin                  │
│         Powered by Telnyx Inference (hosted LLMs)            │
└─────────────────────────────────────────────────────────────┘
```

Everything runs on Telnyx Edge: KV via the REST API from Python and the `env.KV` binding from TypeScript,
the actor on the Edge actor runtime, the MCP server and webhook as Edge
Functions. Only unit tests use fakes (owner's rule #14 — no local stand-ins).

### Components

| Component | Runtime | Owns | Talks to |
| --- | --- | --- | --- |
| Assistant + workflow | Telnyx Voice AI | conversation flow, routing | webhook (once/call), mcp-server (per tool call) |
| `webhook` | Edge Function · Python | nothing (stateless) | KV REST, session-actor HTTP facade |
| `mcp-server` | Edge Function · TypeScript | nothing (stateless) | KV binding, flytlv HTTP, shared actor `env.SESSIONS` → `CallerSession`, session-actor HTTP `/metrics/add` |
| `session-actor` | Edge Actor · TypeScript | per-caller state, itinerary HTML files | actor storage, Cloud Storage `ITINERARIES` bucket, `env.TELNYX` messaging (alarm SMS) |
| KV namespace | Telnyx KV | flags, caches, session map | — |
| Cloud Storage `flytlv-itineraries` | Telnyx Cloud Storage | itinerary HTML pages written by `saveDeal` | served at `GET /itineraries/<uuid>.html` on the session-actor function |

### Why Stateful Actor vs KV vs plain function logic

The challenge stresses picking the right primitive for each piece of state.
This is the reasoning for every piece: see `docs/design/DECISIONS.md` (#9, #11, #13) for
the full rationale.

| State | Primitive | Why this primitive |
| --- | --- | --- |
| Feature flags (toggle workflow paths) | **KV** (`flags/assistant`) | Read-mostly, set by an operator, toggles routing without a redeploy; eventual consistency is fine. KV is the cheapest global read here. |
| Cached flytlv deal searches | **KV** + `ttl_secs` (`cache/deals/<sig>`) | Avoids repeat upstream calls for identical queries; stale-for-seconds is acceptable and the same key can re-`slim()` without another hit (the raw payload is cached). |
| Conversation → caller mapping | **KV** + `ttl_secs` (`session/<conv_id>`) | Written **once** by the webhook at call start, read-only by MCP tools. No read-modify-write, so KV wins. Deliberately *not* an LLM-supplied tool arg — a malicious/invented number could act on another caller's saved deals (decision #11). |
| Per-caller `callCount`, `lastResults`, `savedDeals` | **Stateful Actor** (one per caller) | Atomic read-modify-write per caller. KV is last-write-wins with no compare-and-set, so two concurrent calls from one caller (a re-dial mid-teardown) would race and lose updates. The actor serializes each instance's method turns one at a time — the lock we want, for free. `lastResults` lives here so `save_deal` can only save a deal actually offered (the model cannot invent one — decision #13). |
| Per-request data (auth check, slimmed deals, trace id) | **Plain function logic** | Lives for one request; nothing to persist. No primitive needed. |

Edge-side constraint that shaped this: the KV `env` binding is TypeScript-only,
so the Python webhook reaches KV through the official `telnyx` SDK REST API
(decision #2), the TypeScript MCP server uses `env.KV`, and the actor uses
`this.ctx.storage` directly.

**Proof of the read-modify-write guarantee.** `scripts/ops/actor_concurrency_check.py`
fires 20 concurrent `recordCall` requests at one fresh caller actor on the live
Edge deployment. Every count 1..20 comes back exactly once and the final
`callCount` is 20: no lost updates. A KV counter (last-write-wins, no
compare-and-set) cannot guarantee that.

## Conversation Workflow

12 nodes, 4 speak + 7 prompt + 1 tool node (a prompt fallback in tests/dry
runs); 26 edges, using all three documented condition kinds (`default`,
`expression` for deterministic facts, `llm` for intent). Built in
`assistant/flow.py` (`build_flow`) and validated by `validate()`. The start
node is the greeting speak node. The step 9 upgrade added named-destination,
global-discovery ("anywhere"), one-way, direct/connecting, cheapest-first and
travel-pattern coverage with natural follow-ups — see
[Capabilities and safety rules (step 9)](#capabilities-and-safety-rules-step-9)
below.

### Nodes

| Node | Type | `instructions_mode` | Does |
| --- | --- | --- | --- |
| `greeting` | speak | — | Verbatim welcome + AI disclosure. The start node; its one default edge. |
| `identify_intent` | prompt | append | Routing hub. If `caller_known`, acknowledges "welcome back" with `last_saved_deal`; then detects intent. Expression edges are evaluated before the model turn (deterministic facts never depend on model judgement — decision #12). |
| `degraded_notice` | speak | — | Apology when the backend is degraded; flows to farewell. |
| `deals_disabled` | speak | — | Notice when the deals feature flag is off; flows to farewell. |
| `timeout_escalate` | prompt | replace | Offers a transfer to a human once the call is long (escalation stretch goal). `replace` keeps the model tightly on task. |
| `search_flights` | prompt | append | Calls the `search_deals` MCP tool; reads back the top 2–3 deals (city, price, dates, airline, direct); offers to save one. Never invents data. |
| `save_deal` | prompt | append | Calls `save_deal` to save one of the deals just read out; the caller picks by position. |
| `list_saved` | prompt | append | Calls `list_saved_deals` to read back deals saved on previous calls. |
| `answer_faq` | prompt | append | Answers general questions from a 23-entry knowledge base (`FAQ_ENTRIES` in flow.py): departure city, one way, holidays, weekends, trip lengths, discount and deal quality, layovers, booking, SMS, saved deals, privacy, what is not covered; no tools. |
| `transfer_call` | prompt | append | Calls the inline `transfer` tool to hand off to a human. |
| `farewell` | speak | — | Verbatim goodbye. |
| `hangup_call` | prompt | replace | Calls the inline `hangup` tool to end the call. |

### Edges

Declaration order is priority order. From `identify_intent`, expression edges
(degraded → flag → timeout) all win over the LLM intent edges, so a broken
backend or a disabled flag is handled deterministically, not by model guess.

| From | To | Condition | Kind |
| --- | --- | --- | --- |
| `greeting` | `identify_intent` | (required single default for a speak node) | default |
| `identify_intent` | `degraded_notice` | `backend_degraded == "true"` | expression (string ==) |
| `identify_intent` | `deals_disabled` | `flag_deals_enabled == "false"` | expression (string ==) |
| `identify_intent` | `timeout_escalate` | `telnyx_conversation_duration_secs >= 600` | expression (number >=) |
| `identify_intent` | `search_flights` | "caller wants to search for cheap flights" | llm |
| `identify_intent` | `save_deal` | "caller wants to save one of the deals just read out" | llm |
| `identify_intent` | `list_saved` | "caller wants to hear deals saved on previous calls" | llm |
| `identify_intent` | `answer_faq` | "caller asks a general question about the service" | llm |
| `identify_intent` | `transfer_call` | "caller wants to speak to a human agent" | llm |
| `degraded_notice` | `farewell` | (speak node's single default edge) | default |
| `deals_disabled` | `farewell` | (speak node's single default edge) | default |
| `timeout_escalate` | `transfer_call` | "caller accepts transfer / escalate now" | llm |
| `search_flights` | `save_deal` | "caller wants to save one of the deals just read out" | llm |
| `search_flights` | `identify_intent` | "caller wants a new search / different filters" | llm |
| `save_deal` | `identify_intent` | "deal saved or could not be saved; another request" | llm |
| `list_saved` | `identify_intent` | "heard saved deals; may have another request" | llm |
| `answer_faq` | `search_flights` | "caller wants to search now" | llm |
| `answer_faq` | `identify_intent` | "question answered; another request" | llm |
| `timeout_escalate` | `farewell` | "caller declines the transfer, or no human is available" | llm |
| `transfer_call` | `farewell` | "transfer made or unavailable; wrap up" | llm |
| `farewell` | `hangup_call` | (speak node's single default edge) | default |

`validate()` enforces this structure: start node exists, edge targets exist,
condition types are one of {`default`,`llm`,`expression`}, and every speak node
has exactly one outgoing `default` edge.

### Why these edges — LLM vs expression vs default

- **expression edges** for the two dynamic-variable facts
  (`flag_deals_enabled`, `backend_deals`) and the Telnyx system variable
  (`telnyx_conversation_duration_secs`). They are facts, evaluated before the
  model turn — a degraded backend must never depend on the model noticing it.
- **llm edges** for intent detection — the caller's phrasing varies, so routing
  needs natural-language judgement.
- **default edges** for every speak node (required) and to close the
  greeting → identify_intent hop.

### Capabilities and safety rules (step 9)

The step 9 upgrade taught the `search_flights` and `save_deal` prompt nodes
the full capability list, each mapped only to `search_deals` arguments the
tool really exposes (`tests/check_flow_capabilities.py` keeps that invariant):

- **Flight search:** from TLV; a named destination (IATA); global discovery
  ("anywhere"); one-way and round trip; direct and connecting; cheapest first
  (or best-value / biggest-discount / soonest / fastest); flexible dates and
  date ranges.
- **Travel patterns:** mid-week, weekend, long weekend, short break, 4–5 day
  trip, 7-day trip, flexible — each mapped to concrete `search_deals` args
  (dates/weekdays/`weekend`, `min_nights`/`max_nights`, `category`, `sort`).
- **Conversation:** natural follow-up questions, context kept for the whole
  call, refine preferences, compare prices and destinations, offer
  alternatives when nothing matches.
- **Actions:** give the booking link, text it with `send_deal_sms` (only when
  `flag_sms_enabled` and after a read-back + yes), transfer to a human, end
  the call.

**Safety / accuracy rules** (in the step instructions, enforced by the actor
validating every save against the deals it was actually offered — decision #13):

- Never invent availability or prices — every detail spoken must come from the
  tool result.
- Never claim a booking was completed — say "I found a flight", never "you are
  booked"; the caller books themselves on flytlv.app through `deal_url`.
- Make clear that deals come from the live feed and prices can change until the
  caller books.
- Read back destination, dates, price with currency and direct/connecting, and
  get a clear yes before sending a link (by voice or SMS).

## Dynamic variables

The webhook (`fde-webhook`) overrides the assistant's `flow.DEFAULT_VARIABLES`
at call start; if it fails entirely the defaults keep expression edges from
comparing against raw `{{placeholders}}`:

| Variable | Source | Default | Used by |
| --- | --- | --- | --- |
| `caller_known` | actor profile present | `false` | `identify_intent` (welcome-back) |
| `call_count` | actor `callCount` | `0` | greeting / welcome-back |
| `saved_count` | actor `savedCount` | `0` | greeting / welcome-back |
| `last_saved_deal` | actor `lastSaved` ("Larnaca, 64 USD") | `` | `identify_intent` welcome-back |
| `backend_degraded` | the actor or the KV session write failed/timed out (a failed flags read only falls back to default flags) | `false` | expression edge → `degraded_notice` |
| `flag_deals_enabled` | KV flag `deals_enabled` | `true` | expression edge → `deals_disabled` |

### How the variables personalise the call and steer the workflow

- **Personalise (prompt text):** `identify_intent` greets a returning caller with
  `{{call_count}}` and `{{last_saved_deal}}` ("Welcome back, last time you saved
  Larnaca, 64 USD") and offers to re-check that destination or read their
  `{{saved_count}}` saved deals.
- **Route (expression edges, evaluated before the model):** `backend_degraded`
  sends the call to a scripted notice; `flag_deals_enabled = "false"` (a KV flag)
  turns deal search off for everyone without a redeploy.
- **Feature flags from KV (`flags/assistant`), no redeploy:** every flag becomes
  `flag_<name>`. `sms_enabled` turns SMS offers on or off; `promo` is a one-line
  promotion the assistant mentions once. Defaults live in `assistant/flow.py`
  (`DEFAULT_VARIABLES`) so a missing flag never reaches the caller as a raw
  `{{placeholder}}`.
- **Telnyx system variables:** `{{telnyx_current_time_Asia/Jerusalem}}` gives the
  model today's date in Israel, so "next Friday" or "this weekend" become exact
  dates; `telnyx_conversation_duration_secs` drives the 10-minute escalation.

## MCP tools

The MCP server (`fde-mcp`, TypeScript) exposes four tools the workflow's prompt
nodes call mid-conversation over stateless Streamable HTTP:

| Tool | Does | Actor method |
| --- | --- | --- |
| `search_deals` | Query flytlv (KV-cached) for round trips (`/api/private/deals`) or one-way flights (`/api/private/flights`) and read deals back with airports, weekdays, dates, times, flight numbers, nights, connections and layovers, price, **discount vs the usual price, savings and deal quality**; remember them. Arguments: `trip_type`, `destination`, `country`, `category` (holidays such as Hanukkah or Purim, and trip styles such as Weekend, Weekdays, 1 Month), `weekend` (Thu-Sat dates computed on the server), `departure_date`, `departure_weekday`, `min_nights`/`max_nights`, `max_price`, `min_discount_pct`, `direct_only`, `max_layover_hours`, `time_of_day`, `sort` (cheapest, best_value, biggest_discount, soonest, fastest). Flights leaving within 3 hours are dropped. | `setLastResults` |
| `save_deal` | Save one of the last-shown deals (the actor validates the choice); the actor returns `itineraryUrl` when Cloud Storage is bound, surfaced back to the model. | `saveDeal` |
| `list_saved_deals` | Read the deals saved on previous calls | `getSaved` |
| `send_deal_sms` | Text the caller a shown deal and its booking link (and `Itinerary: <url>` when the actor returned one) from the alphanumeric sender `FlyTLV` (Telnyx Israeli numbers are voice-only). Only to the number the caller is calling from, only a deal they were offered. | `saveDeal`, `getSaved` |

**Tool scoping per node.** Telnyx scopes tools per workflow node through
`shared_tool_ids` (+ `tools_mode`), which take only org-level shared tools
(webhook, function, handoff, retrieval, pay, ...). An MCP server is attached at
the assistant level (`mcp_servers`) and is not a shared-tool type, so all four
MCP tools are visible at every prompt node. Each node's instructions name the one
tool that step should call, and the server enforces the safety rules itself:
`save_deal` and `send_deal_sms` only accept a deal the caller was offered, and
the SMS only goes to the caller's own number.

Tool failures raise `ToolError` → the LLM receives `isError: true` with a
caller-friendly message (never a traceback, URL or API key).

## Observability

Every service emits one structured JSON line per event, one latency line per
request (`webhook.request`, `mcp.request`, `actor.request`, each with
`duration_ms`), and a shared `trace_id` (= `telnyx_conversation_id`) that threads
a single call through webhook → actor and MCP → actor (sent as `x-trace-id`).
Caller numbers are masked to the last 4 digits. See [docs/design/OBSERVABILITY.md](docs/design/OBSERVABILITY.md).

### How I'd know within a minute that the assistant is broken

1. **`telnyx-edge metrics fde-webhook`** — the webhook is the canary: every
   single call hits it first, before any model turn. Rising `4xx`/`5xx` counts
   or `p95` climbing toward the 1.5 s `dynamic_variables_webhook_timeout_ms`
   is the first sign. *This is what I look at first.*
2. **`telnyx-edge logs fde-webhook --tail --json | jq 'select(.outcome!="ok")'`**
   — classify instantly:
   - `outcome: "rejected"` → signature or Telnyx/public-key problem (config).
   - `outcome: "degraded"` → KV or the actor is down; the `degraded` array names
     which dependency (e.g. `["profile"]`).
   - `event: "webhook.dependency_failed"` (ERROR, with traceback) → the actual
     failure of one of the parallel fan-out calls.
3. **Follow the `trace_id`** (the conversation id in every webhook line) into the
   other two services:
   ```bash
   for fn in fde-webhook fde-mcp fde-session-actor; do
     telnyx-edge logs $fn --type runtime --json --since 1h
   done | jq -c 'select(.trace_id=="<conversation-id>")'
   ```
   One id, three logs — reconstruct one call end-to-end, including each
   `mcp.request` span (tool, status, `duration_ms`), the `mcp.search_deals` /
   `mcp.save_deal` lines, the `actor.request` spans, and any `flytlv.feed_off` ERROR (the 404 fail-closed feed,
   logged once per instance).

The **`backend_degraded="true"`** dynamic variable flows straight back to the
assistant, so even before I look at logs the workflow is already routing those
calls to `degraded_notice` instead of reading raw `{{placeholders}}` on air — a
broken backend is partially self-protecting.

Signal cheat-sheet: structured JSON logs (all services) · latency spans
(`webhook.request` / `mcp.request` / `actor.request`, `duration_ms`) ·
distributed `trace_id` · platform metrics (`telnyx-edge metrics <fn>`: count,
2xx/4xx/5xx, p50/p95/p99) · degraded-mode flag (response + log).

### Service metrics (beyond logs)

Counters and latency live in a second Stateful Actor, **`MetricsCounter`** (one
`global` instance), shared by the webhook and the MCP server via the facade's
`POST /metrics/add`. Why an actor: Edge instances scale to zero (in-memory
counters reset) and KV loses concurrent increments; the actor's one-at-a-time
method turns make every increment an atomic read-modify-write.

| Metric | From | Meaning |
| --- | --- | --- |
| `webhook.calls`, `webhook.rejected` | webhook | calls started; bad signature or JSON |
| `webhook.degraded`, `webhook.failed.<dep>` | webhook | calls on the degraded path, and which dependency failed |
| `callers.new` / `returning` / `anonymous` | webhook | who is calling |
| `mcp.tool_calls`, `tool.<name>`, `tool.errors` | MCP | tool usage and caller-facing tool errors |
| `cache.hit`, `cache.miss` | MCP | KV deals-cache effectiveness |
| `flytlv.calls`, `flytlv.errors` | MCP | upstream deals API calls and failures |
| `deals.saved`, `sms.sent` | MCP | business outcomes |
| latency: `webhook.request`, `tool.<name>`, `flytlv.search` | both | count, avg and max ms |

```bash
python scripts/ops/metrics.py          # counters, degraded rate, cache hit rate, latency
python scripts/ops/metrics.py --reset  # start a demo from zero
```

Metrics are sent after the webhook's response (no cost to its 1.2 s budget) and
fire-and-forget from the MCP server, so a metrics failure never affects a call.

### What broke during development, and how I found it

Each of these was found from logs, deploy records or a live check, not by guessing.

1. **Python functions crashed with `No module named 'function'`.** Signal: the
   runtime log (`telnyx-edge logs fde-webhook`) showed the import failing on every
   start, while the same package installed fine locally on Python 3.9. Second
   signal: the TypeScript build reported `File '/workspace/src/kv.ts' not found`
   for a file that exists. Proof: shipping the **unmodified official Python
   scaffold** failed the same way (hatchling: "Unable to determine which files to
   ship"). Cause: `telnyx-edge` 0.5.9 on Windows zips paths with backslashes, so
   the Linux builders see flat files instead of folders. Fix: ship from Linux
   (`.github/workflows/ship.yml`).
2. **Every KV call returned 401.** Signal: `mcp.session_read_failed` WARNING with
   `HTTP 401 ... The provided token is expired`; `telnyx-edge bindings validate`
   confirmed the org API-key binding behind the KV binding had expired. Fix:
   renew it (`PUT /v2/compute/bindings/{id}`).
3. **The MCP server was killed about 28 s after every start.** Signal:
   `mcp.listening` followed by `Terminated` in the runtime log, in a loop. Cause:
   the platform probes `/health/liveness` and `/health/readiness`; the server only
   answered `/health`. Fix: answer every path under `/health`.
4. **The deals cache never worked.** Signal: `mcp.cache_read_failed` WARNING with
   `HTTP 400 Invalid key format` (searches still succeeded, so only the log showed
   it). Cause: cache keys contained `|` and `,`. Fix: KV-legal keys.
5. **"Pick a deal I read out" came back as "service unavailable".** Signal: the
   actor facade's `dispatch_failed` ERROR showed the actor's `ActorInputError`
   arriving as an RPC 500. Fix: the facade recovers it and returns 400.
6. **Every call was degraded.** Signal: the new metrics showed `webhook.calls 17`,
   `webhook.degraded 17`, `webhook.failed.session 17`, and the logs showed
   `dependency budget exceeded (1.2s)` for the flags read and the session write.
   Measured Telnyx KV over REST: 1.2-3.7 s per read, ~2 s per write. Fix: write the
   session after the response, cache flags for 60 s, 2.5 s budget for the actor.
7. **Test assistants hit the account's TeXML app cap.** Signal: `403 Account Level
   Limit Reached ... 10 TeXML Application(s)`. Deleting an assistant does not delete
   the TeXML application Telnyx created for it. The workflow-path script now uses one
   test copy and deletes both.

## Setup

```bash
# Python environment (Windows paths; use .venv/bin/python on macOS/Linux)
uv venv .venv
uv pip install --python .venv/Scripts/python.exe -r requirements-dev.txt

# Configuration: copy and fill in (never commit .env)
cp .env.example .env

# OpenCode with Telnyx Inference
opencode auth login --provider telnyx --method "API Key"
opencode plugin @telnyx/opencode       # then /telnyx in the TUI to pick a model

# Telnyx Edge CLI
telnyx-edge auth api-key set <TELNYX_API_KEY>
telnyx-edge storage kv create --name fde-kv   # the KV_NAMESPACE_ID goes in .env
```

## Test

```bash
python scripts/build/vendor_shared.py                  # copy shared/common.py into each Python service
.venv/Scripts/python -m ruff check .            # lint Python (excludes .venv, node_modules, reference/ via .gitignore)
.venv/Scripts/python -m pytest tests -q       # Python services (29 tests)
cd services/session-actor && npm test           # actor (7 tests)
cd services/session-actor && npm run check      # itinerary + alarm self-check (step 7)
cd services/mcp-server && npm test               # MCP server (11 tests)
.venv/Scripts/python -m pytest tests/check_flow_capabilities.py -q   # step 9 capability self-check
```

## Deploy

Edge secrets are org-scoped and injected as env vars into the functions. Create
each once:

### Edge secrets list

| Secret | Used by | Purpose |
| --- | --- | --- |
| `TELNYX_API_KEY` | webhook, mcp-server, assistant | Telnyx SDK auth (auto-injected on Edge by the `[telnyx]` binding; also used by `provision.py`) |
| `TELNYX_PUBLIC_KEY` | webhook | Ed25519 webhook signature verification (`client.webhooks.unwrap`) |
| `KV_NAMESPACE_ID` | webhook, mcp-server | Telnyx KV namespace id (from `kv create`) |
| `ACTOR_SERVICE_URL` | webhook, mcp-server | `https://fde-session-actor-<id>.telnyxcompute.com` |
| `INTERNAL_API_TOKEN` | webhook, mcp-server, session-actor | shared bearer the webhook and MCP server send and the actor facade validates (decision #8) |
| `MCP_API_KEY` | mcp-server, assistant | bearer the assistant sends to the MCP server; stored as a Telnyx integration secret (`api_key_ref`) |
| `FLYTLV_API_KEY` | mcp-server | flytlv.app private deals feed (`X-API-Key` header; 404 if rejected) |

Non-secret runtime knobs live in each `func.toml` / `telnyx.toml` `[env_vars]`
block (budgets, cache TTLs, prefixes, timeouts, `LOG_LEVEL`).

### Ship the services (GitHub Actions)

Deploys run from Linux in GitHub Actions
([.github/workflows/ship.yml](.github/workflows/ship.yml)), because
`telnyx-edge` on Windows zips paths with backslashes and breaks multi-folder
functions (see "What broke during development" above). The workflow vendors
`shared/common.py`, installs `telnyx-edge` v0.5.9, logs in with the repo secret
`TELNYX_API_KEY` and runs `telnyx-edge ship` for each service.

- **Automatic:** a push to `master` that changes `services/` or `shared/` ships
  all three services.
- **Manual:** Actions → *Ship Edge Functions* → *Run workflow*, with `service` =
  `all`, `webhook`, `mcp-server` or `session-actor`.
- One ship per function at a time: a second one gets `409 Function Busy`.

From Linux or macOS the same commands work by hand:

```bash
python scripts/build/vendor_shared.py                    # copy shared/common.py into Python services
telnyx-edge ship --from-dir services/webhook       # fde-webhook (Python)
telnyx-edge ship --from-dir services/mcp-server    # fde-mcp (TypeScript)
telnyx-edge ship --from-dir services/session-actor # fde-session-actor (umbrella telnyx.toml)
```

The webhook's `pyproject.toml` lists what Edge installs on Python 3.9
(`telnyx[webhooks]`, `httpx`, `starlette` 0.49.3). The MCP server and the actor
are TypeScript (`package.json`). The actor reads `INTERNAL_API_TOKEN` through its
`[[secrets]]` binding. SMS uses the Telnyx messaging profile `flytlv-sms`
(alphanumeric sender `FlyTLV`, Israel only, $5/day spend cap), configured in
`services/mcp-server/func.toml`.

### Provision the assistant (`provision.py`)

After the three Edge services are live, provision the assistant end-to-end with
the official Telnyx SDK. `assistant/provision.py --dry-run` prints the assistant
body that *would* be created (no API calls); used by the unit test.

```bash
python assistant/provision.py --dry-run     # review the body, no API calls

# Provision for real (env filled in — nothing is hardcoded):
TELNYX_API_KEY=... \
ASSISTANT_MODEL=zai-org/GLM-5.3-Flash \
ASSISTANT_VOICE=Telnyx.KokoroTTS.af_heart \
WEBHOOK_URL=https://fde-webhook-<id>.telnyxcompute.com \
MCP_URL=https://fde-mcp-<id>.telnyxcompute.com MCP_API_KEY=... \
ASSISTANT_PHONE_NUMBER_ID=... TRANSFER_TO_NUMBER=... \
python assistant/provision.py
```

Re-running is safe: an existing integration secret is reused, `MCP_SERVER_ID`
reuses the registered MCP server, and `ASSISTANT_ID` updates the existing
assistant instead of creating another. The model must be one Telnyx marks
`recommended_for_assistants` in `/v2/ai/models` (GLM-5.3 is not; GLM-5.3-Flash is).

It runs four ordered steps (each logged as structured JSON):

1. **Integration secret** — stores `MCP_API_KEY` (`/v2/integration_secrets`).
2. **MCP server** — `/ai/mcp_servers` pointing at the deployed MCP Edge
   Function, authenticated via the secret (`api_key_ref`).
3. **Assistant** — `/ai/assistants` with the conversation workflow, dynamic
   variables webhook + defaults, MCP server reference, and inline
   `hangup`/`transfer` tools built by `assistant/flow.py`.
4. **Phone number** — links an owned number to the assistant's voice connection
   (soft step: if Telnyx exposes no connection id, the number is left for a
   one-click link in the Portal rather than aborting).

Deploy order is fixed (the assistant references the live webhook + MCP URLs):
**secrets → KV → `ship` webhook · mcp-server · session-actor → `provision.py`**.

## Tool comparison

<a id="which-model-built-each-component"></a>

OpenCode with Telnyx-hosted models built the first version of every component
and every change from 7 Oct 2026 (steps 7-14); the fixes and features between
the first deploy (6 Oct 2026, 18:00 Israel time) and 7 Oct morning were made
with another AI coding tool, for comparison, as the challenge allows.

## Repository layout

```
README.md  AGENTS.md  .env.example     entry points: overview, rules for the coding agent, config template
requirements-dev.txt  pyrefly.toml     Python dev dependencies, editor type-check config
.opencode/opencode.json                OpenCode config with the @telnyx/opencode plugin
.github/workflows/ship.yml             deploys the services to Telnyx Edge (Linux runner)

services/                              LIVE: what runs on Telnyx Edge
  webhook/                             Dynamic Variables webhook (Python Edge Function)
  mcp-server/                          MCP server, 4 tools (TypeScript Edge Function)
  session-actor/                       CallerSession + MetricsCounter Stateful Actors + HTTP facade
shared/common.py                       Python code shared by the services (vendored into each)
assistant/                             PROVISIONING: workflow (flow.py) + provision.py via the Telnyx SDK

scripts/                               see scripts/README.md
  build/vendor_shared.py               copy shared/common.py into each Python service
  ops/live_check.py                    end-to-end PASS/FAIL check of the deployed services
  ops/metrics.py                       live metrics dashboard (--reset before a demo)
  ops/actor_concurrency_check.py       proof: concurrent actor updates lose nothing

docs/                                  see docs/README.md
  challenge/                           code_challenge.md (the brief), USE_CASE.md
  design/                              ARCHITECTURE.md, DECISIONS.md, OBSERVABILITY.md
  guides/                              HOW_TO_CALL.md (callers), DEMO_SCRIPT.md (demo day)
  build/PROMPTS.md, DOGFOODING.md      OpenCode build prompts; what worked and what did not

tests/                                 acceptance tests (not edited) + self-checks; see tests/README.md
```

## OpenCode config

[.opencode/opencode.json](.opencode/opencode.json) loads the `@telnyx/opencode`
plugin. Enabled models are listed in [docs/build/PROMPTS.md](docs/build/PROMPTS.md). The Telnyx-hosted
model id powering this coding session is `telnyx/zai-org/GLM-5.2`.
