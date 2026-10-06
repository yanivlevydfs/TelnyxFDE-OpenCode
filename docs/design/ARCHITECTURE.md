# Architecture

```
Caller (phone)
   │
   ▼
Telnyx AI Assistant ── Conversation Workflow (speak / prompt / tool nodes, edges)
   │  1. conversation start                 │  2. mid-conversation tool calls
   ▼                                         ▼
webhook  (Python Edge Function)          mcp-server  (TypeScript Edge Function)
   │  ├─ KV REST: flags, session write       │  ├─ KV env.KV: session read, deals cache, flags
   │  └─ HTTP ─┐                             │  ├─ HTTP: flytlv.app deals API, Telnyx SMS
   │           │                             │  └─ HTTP ─┐
   │           ▼                             │           ▼
   │      session-actor (TypeScript Edge Function: HTTP facade)
   │           ├─ CallerSession  Stateful Actor (one instance per caller)
   │           └─ MetricsCounter Stateful Actor (one "global" instance, metrics)
   ▼
{"dynamic_variables": {...}}  → instructions, speak nodes, variable-comparison edges
```

## Components

| Component | Runs | Owns | Talks to |
| --- | --- | --- | --- |
| Assistant + workflow | Telnyx Voice AI | Conversation flow, routing | webhook (once), mcp-server (per tool call) |
| webhook | Edge Function, Python | Nothing (stateless) | KV, session-actor |
| mcp-server | Edge Function, TypeScript | Nothing (stateless) | KV, session-actor |
| session-actor | Edge Function, TypeScript | Per-caller state (CallerSession), service metrics (MetricsCounter) | Actor storage |
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

**Tool call (mcp-server).** The tool resolves the caller from `session/<conversation_id>` in KV, then calls the flytlv deals API (KV-cached) and the caller's actor (last results, saved deals). Telnyx POSTs one JSON-RPC message per call (stateless
Streamable HTTP, JSON response). Bearer token checked → tool runs → result returned as MCP
`content` + `structuredContent`. Tool failures return `isError: true` so the LLM can recover.

## Service-to-service security

- webhook: Telnyx Ed25519 signature + timestamp tolerance (replay protection).
- mcp-server: bearer token (`MCP_API_KEY`, registered with Telnyx as `api_key_ref`).
- session-actor: bearer token (`INTERNAL_API_TOKEN`), method allowlist, entity-id validation.

## Platform constraints that shaped the design

- Stateful Actors: TypeScript-only, no REST → separate TypeScript facade service.
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
