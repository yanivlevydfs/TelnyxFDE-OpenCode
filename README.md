# FlyTLV Travel Line

A phone line for cheap round-trip flights from Tel Aviv. You call a Telnyx AI
Assistant and ask for a deal ("something cheap to Cyprus in November"). It
reads back the 2–3 cheapest deals from the live `flytlv.app` deals API, can
save one, and on your next call says "Welcome back, last time you saved Larnaca
for 64 dollars."

Built for the Telnyx FDE coding challenge ([code_challenge.md](code_challenge.md)).
Requirement 6: the first version of every component was built by **OpenCode powered
by Telnyx Inference** from the spec and the acceptance tests. Deploying to Telnyx
Edge and the features added after the first deploy were done with **Claude Code**.
See [Which model built each component](#which-model-built-each-component).

- Use case: [USE_CASE.md](USE_CASE.md)
- Design: [spec/ARCHITECTURE.md](spec/ARCHITECTURE.md), [spec/DECISIONS.md](spec/DECISIONS.md),
  [spec/OBSERVABILITY.md](spec/OBSERVABILITY.md)
- Demo script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)
- How to talk to the phone agent: [docs/HOW_TO_CALL.md](docs/HOW_TO_CALL.md)
- Rules for the coding agent: [AGENTS.md](AGENTS.md); build prompts & status: [PROMPTS.md](PROMPTS.md)

## Status

| Component | Folder | First version (OpenCode) | Since first deploy | Tests | Deployed |
|---|---|---|---|---|---|
| Shared code | `shared/common.py` | GLM-5.2 | Claude Code | 13/13 | vendored into each Python service |
| Dynamic Variables webhook | `services/webhook` | Kimi-K3 | Claude Code | 9/9 | live, `fde-webhook` |
| MCP server (4 tools) | `services/mcp-server` | GLM-5.2 (Python, then the TypeScript port) | Claude Code | 11/11 | live, `fde-mcp` |
| CallerSession Stateful Actor | `services/session-actor` | GLM-5.2 | Claude Code | 7/7 | live, `fde-session-actor` |
| Assistant + Conversation Workflow | `assistant/` | GLM-5.2 | Claude Code | 7/7 | live (`provision.py`) |
| Deploy pipeline | `.github/workflows/ship.yml` | — | Claude Code | — | GitHub Actions |
| Phone number | — | — | — | — | linked; awaiting Telnyx regulatory approval |

Total: **47 tests** (29 Python + 11 MCP + 7 actor) green: `.venv/Scripts/python -m pytest UnitTest -q`,
`cd services/mcp-server && npm test` and `cd services/session-actor && npm test`.

**Live endpoints and phone number**

| What | Where |
|---|---|
| Phone | **+972 76-567-1113** (how to talk to it: [docs/HOW_TO_CALL.md](docs/HOW_TO_CALL.md)) |
| Assistant | `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16` (GLM-5.3-Flash) |
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
session map) and the **Actor** (last results / saved deals) and the
**flytlv.app** deals feed.

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
   │  └─ HTTP ─▶ session-actor: setLastResults / saveDeal / getSaved

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
|---|---|---|---|
| Assistant + workflow | Telnyx Voice AI | conversation flow, routing | webhook (once/call), mcp-server (per tool call) |
| `webhook` | Edge Function · Python | nothing (stateless) | KV REST, session-actor HTTP |
| `mcp-server` | Edge Function · TypeScript | nothing (stateless) | KV binding, flytlv HTTP, session-actor HTTP |
| `session-actor` | Edge Actor · TypeScript | per-caller state | actor storage |
| KV namespace | Telnyx KV | flags, caches, session map | — |

### Why Stateful Actor vs KV vs plain function logic

The challenge stresses picking the right primitive for each piece of state.
This is the reasoning for every piece: see `spec/DECISIONS.md` (#9, #11, #13) for
the full rationale.

| State | Primitive | Why this primitive |
|---|---|---|
| Feature flags (toggle workflow paths) | **KV** (`flags/assistant`) | Read-mostly, set by an operator, toggles routing without a redeploy; eventual consistency is fine. KV is the cheapest global read here. |
| Cached flytlv deal searches | **KV** + `ttl_secs` (`cache/deals/<sig>`) | Avoids repeat upstream calls for identical queries; stale-for-seconds is acceptable and the same key can re-`slim()` without another hit (the raw payload is cached). |
| Conversation → caller mapping | **KV** + `ttl_secs` (`session/<conv_id>`) | Written **once** by the webhook at call start, read-only by MCP tools. No read-modify-write, so KV wins. Deliberately *not* an LLM-supplied tool arg — a malicious/invented number could act on another caller's saved deals (decision #11). |
| Per-caller `callCount`, `lastResults`, `savedDeals` | **Stateful Actor** (one per caller) | Atomic read-modify-write per caller. KV is last-write-wins with no compare-and-set, so two concurrent calls from one caller (a re-dial mid-teardown) would race and lose updates. The actor serializes each instance's method turns one at a time — the lock we want, for free. `lastResults` lives here so `save_deal` can only save a deal actually offered (the model cannot invent one — decision #13). |
| Per-request data (auth check, slimmed deals, trace id) | **Plain function logic** | Lives for one request; nothing to persist. No primitive needed. |

Edge-side constraint that shaped this: the KV `env` binding is TypeScript-only,
so the Python webhook reaches KV through the official `telnyx` SDK REST API
(decision #2), the TypeScript MCP server uses `env.KV`, and the actor uses
`this.ctx.storage` directly.

## Conversation Workflow

11 nodes, 4 speak + 7 prompt; edges use all three documented condition kinds
(`default`, `expression` for deterministic facts, `llm` for intent). Built in
`assistant/flow.py` (`build_flow`) and validated by `validate()`. The start node
is the greeting speak node.

### Nodes

| Node | Type | `instructions_mode` | Does |
|---|---|---|---|
| `greeting` | speak | — | Verbatim welcome + AI disclosure. The start node; its one default edge. |
| `identify_intent` | prompt | append | Routing hub. If `caller_known`, acknowledges "welcome back" with `last_saved_deal`; then detects intent. Expression edges are evaluated before the model turn (deterministic facts never depend on model judgement — decision #12). |
| `degraded_notice` | speak | — | Apology when the backend is degraded; flows to farewell. |
| `deals_disabled` | speak | — | Notice when the deals feature flag is off; flows to farewell. |
| `timeout_escalate` | prompt | replace | Offers a transfer to a human once the call is long (escalation stretch goal). `replace` keeps the model tightly on task. |
| `search_flights` | prompt | append | Calls the `search_deals` MCP tool; reads back the top 2–3 deals (city, price, dates, airline, direct); offers to save one. Never invents data. |
| `save_deal` | prompt | append | Calls `save_deal` to save one of the deals just read out; the caller picks by position. |
| `list_saved` | prompt | append | Calls `list_saved_deals` to read back deals saved on previous calls. |
| `answer_faq` | prompt | append | Answers general questions about the service (booking, one-way, weekends) from fixed facts; no tools. |
| `transfer_call` | prompt | append | Calls the inline `transfer` tool to hand off to a human. |
| `farewell` | speak | — | Verbatim goodbye. |
| `hangup_call` | prompt | replace | Calls the inline `hangup` tool to end the call. |

### Edges

Declaration order is priority order. From `identify_intent`, expression edges
(degraded → flag → timeout) all win over the LLM intent edges, so a broken
backend or a disabled flag is handled deterministically, not by model guess.

| From | To | Condition | Kind |
|---|---|---|---|
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

## Dynamic variables

The webhook (`fde-webhook`) overrides the assistant's `flow.DEFAULT_VARIABLES`
at call start; if it fails entirely the defaults keep expression edges from
comparing against raw `{{placeholders}}`:

| Variable | Source | Default | Used by |
|---|---|---|---|
| `caller_known` | actor profile present | `false` | `identify_intent` (welcome-back) |
| `call_count` | actor `callCount` | `0` | greeting / welcome-back |
| `saved_count` | actor `savedCount` | `0` | greeting / welcome-back |
| `last_saved_deal` | actor `lastSaved` ("Larnaca, 64 USD") | `` | `identify_intent` welcome-back |
| `backend_degraded` | the actor or the KV session write failed/timed out (a failed flags read only falls back to default flags) | `false` | expression edge → `degraded_notice` |
| `flag_deals_enabled` | KV flag `deals_enabled` | `true` | expression edge → `deals_disabled` |

## MCP tools

The MCP server (`fde-mcp`, TypeScript) exposes four tools the workflow's prompt
nodes call mid-conversation over stateless Streamable HTTP:

| Tool | Does | Actor method |
|---|---|---|
| `search_deals` | Query flytlv (KV-cached) and read deals back with airports, dates, times, flight numbers, nights and price; remember them. Arguments: `destination`, `country`, `weekend` (`upcoming`/`following`; Thu-Sat dates computed on the server), `departure_date`, `max_price`, `direct_only`. Flights leaving within 3 hours are dropped. | `setLastResults` |
| `save_deal` | Save one of the last-shown deals (the actor validates the choice) | `saveDeal` |
| `list_saved_deals` | Read the deals saved on previous calls | `getSaved` |
| `send_deal_sms` | Text the caller a shown deal and its booking link from the alphanumeric sender `FlyTLV` (Telnyx Israeli numbers are voice-only). Only to the number the caller is calling from, only a deal they were offered. | `saveDeal`, `getSaved` |

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
Caller numbers are masked to the last 4 digits. See [spec/OBSERVABILITY.md](spec/OBSERVABILITY.md).

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
python scripts/vendor_shared.py                  # copy shared/common.py into each Python service
.venv/Scripts/python -m pytest UnitTest -q       # Python services (39 tests)
cd services/session-actor && npm test           # actor (7 tests)
```

## Deploy

Edge secrets are org-scoped and injected as env vars into the functions. Create
each once:

### Edge secrets list

| Secret | Used by | Purpose |
|---|---|---|
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
python scripts/vendor_shared.py                    # copy shared/common.py into Python services
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

## Which model built each component

Requirement 6: the first version of each component was built with **OpenCode
powered by Telnyx Inference**, one model per component, from the spec in `spec/`
and the acceptance tests in `UnitTest/`. Current `/telnyx` model list for
reference: `moonshotai/Kimi-K3`, `zai-org/GLM-5.x` family, `deepseek-ai/DeepSeek-V4`,
`Qwen3.x`, `MiniMax`.

| Component | Folder | First version built by |
|---|---|---|
| Shared code (config, JSON logging, `Kv`, `ActorClient`, sessions, phone) | `shared/common.py` | **GLM-5.2** · `telnyx/zai-org/GLM-5.2` |
| Dynamic Variables webhook (signature, budget, degraded defaults) | `services/webhook` | **Kimi-K3** · `telnyx/moonshotai/Kimi-K3` |
| MCP server (3 tools, flytlv client, bearer auth; Python, then ported to TypeScript for Edge) | `services/mcp-server` | **GLM-5.2** · `telnyx/zai-org/GLM-5.2` |
| CallerSession Stateful Actor + HTTP facade | `services/session-actor` | **GLM-5.2** · `telnyx/zai-org/GLM-5.2` |
| Assistant + Conversation Workflow + provisioning | `assistant/` | **GLM-5.2** · `telnyx/zai-org/GLM-5.2` |
| Webhook fix for Edge's Python 3.9 build | `services/webhook` | **GLM-5.2** · `telnyx/zai-org/GLM-5.2` |

The OpenCode session history (`opencode.db`) records each of these runs and its model.

**After the first deploy (Claude Code, from 6 Oct ~15:00 UTC).** Shipping to Telnyx
Edge exposed platform problems the tests could not, and those fixes plus the later
features were made with Claude Code:

- Deploys moved to GitHub Actions: the Windows `telnyx-edge` CLI zips paths with
  backslashes, so the Linux builders saw flat files instead of folders.
- MCP `/health/*` probe routes, an expired org API-key binding (KV returned 401),
  actor input errors arriving as RPC 500s, `provision.py` API-shape fixes.
- Features: full flight details, weekend and country search, departure filter,
  SMS deal links, and fixes from a cross-service review.

## Repository layout

```
shared/common.py                     config, JSON logging, Kv (KV REST), ActorClient, sessions, phone
scripts/vendor_shared.py             copy shared/common.py into each Python service as function/common.py
services/webhook/function/func.py    Dynamic Variables webhook (Edge Function, Python)
services/mcp-server/src/             MCP server (TypeScript): search_deals, save_deal, list_saved_deals
services/session-actor/src/          CallerSession Stateful Actor + HTTP facade (TypeScript)
assistant/flow.py, provision.py       Conversation Workflow + provisioning via the Telnyx SDK
UnitTest/                             acceptance tests (do not edit — the job is done when all pass)
spec/                                 ARCHITECTURE.md, DECISIONS.md, OBSERVABILITY.md
docs/DEMO_SCRIPT.md                   8–10 minute demo walk-through
```

## OpenCode config

[.opencode/opencode.json](.opencode/opencode.json) loads the `@telnyx/opencode`
plugin. Enabled models are listed in [PROMPTS.md](PROMPTS.md). The Telnyx-hosted
model id powering this coding session is `telnyx/zai-org/GLM-5.2`.
