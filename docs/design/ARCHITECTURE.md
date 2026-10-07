# Architecture

```
Caller (phone)
   │
   ▼
Telnyx AI Assistant ── Conversation Workflow (speak / prompt / tool nodes, edges)
   │  1. conversation start                 │  2. mid-conversation tool calls
   ▼                                         ▼
webhook  (Python Edge Function)         mcp-server  (TypeScript Edge Function)
   │  ├─ KV REST: flags (60 s cache),        │  ├─ KV env.KV: session read, deals cache, flags
   │  │   session write after the response   │
   │  └─ HTTP ─┐                             │  ├─ HTTP: flytlv.app deals API, Telnyx SMS
   │           │                             │  └─ shared actor (env.SESSIONS) ─┐
   │           ▼                             │                                 │
   │      session-actor (TypeScript Edge Function) ◀───────────────────────────┘
   │      ├─ HTTP facade: POST /actors/{entity}/{method}, POST /metrics/*
   │      │  (kept for the Python webhook — Python Edge cannot bind actors;
   │      │   optional mcp-server fallback when USE_SHARED_ACTOR=false)
   │      │
   │      │  The mcp-server production path: env.SESSIONS.idFromName(entityId)[method](body)
   │      │  — no HTTP hop, type = "CallerSession" declared under the SESSIONS binding,
   │      │  the class code lives in fde-session-actor (Telnyx "shared actors").
   │           ├─ CallerSession   Stateful Actor (one instance per caller)
   │           └─ MetricsCounter Stateful Actor (one "global" instance, metrics)
   ▼
{"dynamic_variables": {...}}  → instructions, speak nodes, variable-comparison edges
```

The MCP server talks to `CallerSession` directly via the **shared actor**
`SESSIONS` binding declared in `services/mcp-server/func.toml`. Telnyx
"shared actors" means the `fde-session-actor` function owns the class and
this function declares only `type = "CallerSession"` under its own binding —
no class code is shipped here. The Edge runtime forwards the call over an
RPC hop to the owning function. The HTTP facade in `services/session-actor`
stays up for the **Python webhook**, which can't bind actors and still goes
through `POST /actors/{entity_id}/{method}` + `Bearer INTERNAL_API_TOKEN`.

## Components

| Component | Runs | Owns | Talks to |
| --- | --- | --- | --- |
| Assistant + workflow | Telnyx Voice AI | Conversation flow, routing | webhook (once), mcp-server (per tool call) |
| webhook | Edge Function, Python | Nothing (stateless) | KV, session-actor (HTTP facade) |
| mcp-server | Edge Function, TypeScript | Nothing (stateless) | KV, CallerSession (shared actor `env.SESSIONS`), KV-cached flytlv; optionally `ActorClient` → session-actor HTTP facade when `USE_SHARED_ACTOR=false` |
| session-actor | Edge Function, TypeScript | Per-caller state (CallerSession), service metrics (MetricsCounter) | Actor storage; HTTP facade for webhook |
| KV namespace | Telnyx KV | Flags, deals cache, conversation → caller session | — |

## Choosing the primitive for each piece of state

| State | Primitive | Why |
| --- | --- | --- |
| Feature flags (toggle workflow paths) | **KV** | Read-mostly, global, changed by an operator; eventual consistency is fine. |
| Cached flytlv deal searches | **KV** with `ttl_secs` | Avoids repeat upstream calls; stale-for-seconds is acceptable. |
| Conversation → caller mapping | **KV** with `ttl_secs` | Written once by the webhook, read by MCP tools; no read-modify-write. |
| Per-caller call count / last results / saved deals | **Stateful Actor** | Read-modify-write. KV has no compare-and-set, so concurrent writes lose updates; an actor serializes calls per entity. |
| Per-request data | **Plain function logic** | Lives for one request; nothing to persist. |

## Request flows

**Conversation start (webhook).** Telnyx POSTs `assistant.initialization` → signature check →
KV flags and `CallerSession.recordCall` run concurrently under `WEBHOOK_BUDGET_MS` → string
variables returned. If a dependency fails or times out, safe defaults are returned with
`backend_degraded="true"` so the workflow can route to a fallback instead of the call
receiving raw `{{placeholders}}`.

**Tool call (mcp-server).** The tool resolves the caller from `session/<conversation_id>` in KV, then calls the flytlv deals API (KV-cached) and the caller's actor (last results, saved deals).
By default the actor call is a direct RPC over the shared `env.SESSIONS` binding
(`EdgeActor` — `env.SESSIONS.idFromName(entityId)[method](body)`); setting
`USE_SHARED_ACTOR=false` reverts to the HTTP facade (`ActorClient` →
`POST /actors/{entity_id}/{method}`) so the same code path is exercisable from
places that can't bind actors (Python webhook, local debugging). The actor's
`ActorInputError` (e.g. "deal not in the last search results") arrives over the
RPC hop as a plain `Error` whose message embeds `{"name":"ActorInputError"}`;
`EdgeActor` recovers it back to `ActorInputError`, so `callActor` maps it to a
caller-safe tool result exactly as for the HTTP path. Telnyx POSTs one JSON-RPC
message per call (stateless Streamable HTTP, JSON response). Bearer token checked
→ tool runs → result returned as MCP `content` + `structuredContent`. Tool
failures return `isError: true` so the LLM can recover.

## Service-to-service security

- webhook → session-actor: Telnyx Ed25519 signature on the inbound webhook
  (replay protection) + bearer `INTERNAL_API_TOKEN` on the outbound actor call.
- mcp-server inbound: bearer token (`MCP_API_KEY`, registered with Telnyx as `api_key_ref`).
- mcp-server → CallerSession (production path): no bearer. The `[[actors]]`
  `SESSIONS` binding is the trust boundary — only a function that declared the
  binding in its `func.toml` can resolve it. `ActorClient` (the HTTP fallback
  path) still uses `Bearer INTERNAL_API_TOKEN` and the method allowlist in the
  facade.
- session-actor HTTP facade: bearer `INTERNAL_API_TOKEN`, method allowlist,
  entity-id validation — only used by the webhook now.

## Platform constraints that shaped the design

- Stateful Actors: TypeScript-only, no REST → separate TypeScript facade service,
  used by the Python webhook. The TypeScript mcp-server goes straight to the
  shared actor binding (`telnyx-edge types` narrows `env.SESSIONS` to the actor's
  public method shape; this function ships no class code — Telnyx "shared actors").
- KV `env` binding: TypeScript-only → Python uses the KV REST API.
- Edge builds each function directory alone → `shared/common.py` is copied into each service before `telnyx-edge ship`.
- Dynamic Variables webhook default timeout 1.5 s + cold starts → concurrent fetches, budget, degraded defaults.
- Functions scale to zero → clients created once per instance, no in-memory state relied upon.

## Where the code lives

See [README.md, Repository layout](../../README.md#repository-layout): `services/`
is what runs on Telnyx Edge, `assistant/` provisions the assistant and its
workflow, `shared/` is vendored into the Python service, `scripts/build` and
`scripts/ops` hold the build and live-operations scripts, and `docs/` is grouped
into challenge, design, guides and build.
