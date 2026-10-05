# FlyTLV Travel Line

A phone line for cheap round-trip flights from Tel Aviv. You call a Telnyx AI Assistant and
ask for a deal ("something cheap to Cyprus in November"). It reads the best options from the
live flytlv.app deals API, and you can save one. The next time you call, it says
"Welcome back, last time you saved Larnaca for 64 dollars."

Built for the Telnyx FDE coding challenge ([code_challenge.md](code_challenge.md)). All
solution code is written by **OpenCode with Telnyx-hosted models** (requirement 6).

- Use case: [USE_CASE.md](USE_CASE.md)
- Design: [spec/ARCHITECTURE.md](spec/ARCHITECTURE.md), [spec/DECISIONS.md](spec/DECISIONS.md),
  [spec/OBSERVABILITY.md](spec/OBSERVABILITY.md)
- Rules for the coding agent: [AGENTS.md](AGENTS.md); build prompts and status: [PROMPTS.md](PROMPTS.md)

## Status

| Component | Folder | Built by | Tests | Deployed |
|---|---|---|---|---|
| Shared code | `shared/common.py` | OpenCode · GLM-5.2 | 13/13 pass | n/a (copied into each service) |
| Dynamic Variables webhook | `services/webhook` | OpenCode · Kimi-K3 | 9/9 pass | Registered as `fde-webhook`, not shipped yet |
| MCP server (3 tools) | `services/mcp-server` | — | — | Registered as `fde-mcp`, no code yet |
| CallerSession Stateful Actor | `services/session-actor` | — | — | No |
| Assistant + Conversation Workflow | `assistant/` | — | — | No |
| Phone number | — | — | — | Not bought yet |

The build is paused until the Telnyx account has credit (inference is billed per use).

**Live endpoints and phone number:** added here after deploy.

## Architecture

```
Caller (phone)
   │
   ▼
Telnyx AI Assistant ── Conversation Workflow (speak / prompt nodes, LLM + expression edges)
   │  1. call start                          │  2. tool calls during the call
   ▼                                          ▼
webhook (Python Edge Function)            mcp-server (Python Edge Function)
   │  ├─ KV: feature flags, session map      │  ├─ KV: cached deal searches
   │  └─ HTTP ─┐                             │  ├─ flytlv.app deals API
   │           ▼                             │  └─ HTTP ─┐
   │      session-actor (TypeScript Edge Function)       │
   │           └─ CallerSession Stateful Actor, one per caller ◀┘
   ▼
{"dynamic_variables": {...}} → greeting, "welcome back", routing
```

| State | Where | Why |
|---|---|---|
| Feature flags | Telnyx KV | Read-mostly, set by an operator, toggles workflow paths without a redeploy |
| Cached deal searches | Telnyx KV with TTL | Avoids repeat calls to flytlv.app |
| Conversation → caller mapping | Telnyx KV with TTL | Written once by the webhook, read by MCP tools |
| Call count, last results, saved deals | Stateful Actor | Read-modify-write per caller; KV has no compare-and-set |

## Conversation Workflow

| Node | Type | What it does |
|---|---|---|
| `greeting` | speak | Verbatim welcome and AI disclosure |
| `find_deals` | prompt | Asks where and when, calls `search_deals`, reads up to 3 deals |
| `save_deal` | prompt | Confirms which deal, calls `save_deal` |
| `paused` | speak | Read when the KV flag turns deal search off |
| `escalate` | prompt | Transfers to a person (when configured) |
| `goodbye` | prompt | Thanks the caller and hangs up |

Routing: expression edges for facts (`flag_deals_enabled`, `backend_degraded`,
`telnyx_conversation_duration_secs`); LLM edges for intent (save, person, done).

## MCP tools

| Tool | Does |
|---|---|
| `search_deals` | Searches flytlv.app by destination, max price, date, direct only; caches in KV; remembers results in the actor |
| `save_deal` | Saves one of the deals just read (the actor rejects anything else) |
| `list_saved_deals` | Reads the caller's saved deals |

## How I'd know within a minute that it's broken

1. `telnyx-edge metrics fde-webhook`: every call hits the webhook first, so rising 4xx/5xx or
   p95 near the timeout is the first sign.
2. `telnyx-edge logs fde-webhook --tail --json`, filtered to `outcome != "ok"`:
   `rejected` points to a signature or key problem, `degraded` to KV or the actor being down.
3. Follow the `trace_id` (the conversation id) into the `fde-mcp` and `fde-session-actor` logs.

Details: [spec/OBSERVABILITY.md](spec/OBSERVABILITY.md).

## Setup

```bash
# Python environment
uv venv .venv
uv pip install --python .venv/Scripts/python.exe -r requirements-dev.txt

# Configuration: copy and fill in (never commit .env)
cp .env.example .env

# OpenCode with Telnyx Inference
opencode auth login --provider telnyx --method "API Key"

# Telnyx Edge CLI
telnyx-edge auth api-key set <TELNYX_API_KEY>
telnyx-edge storage kv create --name flytlv-kv
```

## Test

```bash
python scripts/vendor_shared.py                  # copy shared/common.py into each Python service
.venv/Scripts/python -m pytest UnitTest -q       # Python services
cd services/session-actor && npm test            # actor (once built)
```

## Deploy

```bash
telnyx-edge secrets add <NAME> <VALUE>           # each secret listed in .env.example
python scripts/vendor_shared.py
telnyx-edge ship --from-dir services/webhook
telnyx-edge ship --from-dir services/mcp-server
cd services/session-actor && telnyx-edge ship
python assistant/provision.py                    # assistant, workflow, MCP server, phone number
```

## OpenCode config

[.opencode/opencode.json](.opencode/opencode.json) loads the `@telnyx/opencode` plugin. Enabled
models are listed in [PROMPTS.md](PROMPTS.md).
