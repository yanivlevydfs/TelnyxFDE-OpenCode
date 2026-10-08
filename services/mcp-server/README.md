# mcp-server — MCP tools for the FlyTLV Travel Line

TypeScript Telnyx Edge Function exposing three MCP tools the Telnyx AI
Assistant calls mid-conversation over stateless Streamable HTTP:
`search_deals`, `save_deal`, `list_saved_deals`.

> **TypeScript, not Python.** Telnyx Edge builds Python with 3.9, but the
> official `@modelcontextprotocol/sdk` requires Python 3.10+ — so the Python
> MCP server cannot deploy. This service is the behaviour-identical TypeScript
> port (an Edge Function built on `node:http` + the MCP SDK).

## CallerSession binding (shared actor)

The MCP server reaches the per-caller Stateful Actor through the **`SESSIONS`**
binding declared in `func.toml`:

```toml
[[actors]]
binding = "SESSIONS"
type    = "CallerSession"
```

This is Telnyx "shared actors": one function (`fde-session-actor`) owns the
`CallerSession` class; this function declares the same `type` under its own
`binding` and **ships no class code**. The Edge runtime resolves the actor
over an RPC hop to the owning function. `src/actor.ts`'s `EdgeActor` calls

```ts
env.SESSIONS.idFromName(entityId)[method](body)
```

directly — no HTTP hop, no bearer. `index.ts` wires `EdgeActor` when
`USE_SHARED_ACTOR=true` (the production default in `func.toml` `[env_vars]`),
and falls back to `ActorClient` against `ACTOR_SERVICE_URL` when the flag is
`false`. The HTTP facade in `services/session-actor` stays for the **Python
webhook**, which cannot bind actors and still needs the HTTP surface.

Over the RPC hop an actor's `ActorInputError` arrives as a plain `Error` whose
message embeds `{"name":"ActorInputError"}`; `EdgeActor` maps that marker back
to the MCP `ActorInputError` (caller's fault, e.g. "deal not in the last search
results") and everything else to a transient `ActorError`. `callActor` then
turns those into caller-safe MCP tool results exactly as it did for the HTTP
client, so the two transports are interchangeable.

## Request flow

1. **Bearer auth** — `createHandler` checks `Authorization: Bearer <MCP_API_KEY>`
   before the MCP transport sees the request. Mismatch → `401` JSON.
2. A **fresh** `McpServer` + stateless `StreamableHTTPServerTransport`
   (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) is created
   **per request** (Edge has no request lifespan). `server.connect(transport)`
   then `transport.handleRequest(req, res, parsedBody)`.
3. Each tool resolves the caller from `session/<telnyx_conversation_id>` in KV
   (written by the webhook), then calls the flytlv deals API (KV-cached)
   and/or the caller's Stateful Actor, forwarding the same `trace_id`.
4. `GET /health` → `200 {status:"ok"}` is a lightweight liveness probe (no auth).

## Tools

| Tool | What it does | Actor method |
| --- | --- | --- |
| `search_deals` | Query flytlv (KV-cached), speak deals back, remember them | `setLastResults` (with `query` + `conversationId`) |
| `save_deal` | Save one of the last-shown deals (actor validates the choice) | `saveDeal` (with `conversationId`) |
| `list_saved_deals` | Read the deals saved on previous calls | `getSaved` |

Tool failures return `{ content:[{type:"text",text:msg}], isError:true }` so the
LLM gets `isError: true` with a caller-friendly message (never a traceback,
URL or API key).

### Why remembering matters (decision #13)

`search_deals` stores the deals it read aloud on the caller's actor via
`setLastResults`; `save_deal` may only save a deal the caller was actually
offered — the model cannot invent a price or URL.

### History + audit pass-through (step 20)

`search_deals` forwards the search args as `query` and the Telnyx conversation
id as `conversationId` on every `setLastResults` call; `save_deal` and
`send_deal_sms` forward `conversationId` on every `saveDeal` call. The actor
appends a bounded history entry per event and writes an immutable audit object
to Cloud Storage (see the `services/session-actor` README). No new MCP tool —
the conversation id already arrives in `params._meta.telnyx_conversation_id`.

## Itinerary + reminder config travels with the call (step 11)

**Live finding (7 Oct 08:52 UTC, after the step 7-8 deploy):** the actor's
umbrella `telnyx.toml [env_vars]` for `fde-session-actor` do **NOT** reach
actor instances' `process.env` (actor log:
`itinerary_skipped reason=noITINERARY_BASE_URL`). The Cloud Storage bucket
binding (`[storage.cloudstorage.ITINERARIES]`) *does* reach the actor, but
the four string knobs do not.

This function's own `func.toml [env_vars]` do work, so every `saveDeal`
actor call now ships a `config` field built from them — empty values are
omitted (the actor falls back to `process.env`, its own fallback path for
unit tests / local dev / once the platform honours the actor umbrella):

```jsonc
{ "dealId": "tlv-lca-1",
  "config": {
    "itineraryBaseUrl": "https://fde-session-actor-94b99eb9-4.telnyxcompute.com",
    "reminderDelaySeconds": 600,
    "smsFrom": "FlyTLV",
    "messagingProfileId": "4001a112-28fd-40f5-a0de-226b1bad6b80" } }
```

`save_deal` and `send_deal_sms` both forward it (`saveDealBody` in
`src/server.ts` reads with `config.optional(...)`). The actor resolves
`config.X ?? process.env.X` with type validation (strings, a positive
number; bad ones dropped), and captures `smsFrom` / `messagingProfileId`
into the pending reminder so the `alarm()` turn never relies on
`process.env` at fire time. See `docs/design/DECISIONS.md` (#28) and the
`services/session-actor` README.

## flytlv client (`src/flytlv.ts`)

Minimal async client for `GET {FLYTLV_API_BASE}/api/private/deals`. The
`FLYTLV_API_KEY` Edge secret is **required** and sent as the `X-API-Key`
header on **every** request (header name overridable via
`FLYTLV_API_KEY_HEADER`). `FlytlvClient` is built per request in
`createServer`, so a missing/rejected key makes every request fail before
the feed is called; the function still boots — only `MCP_API_KEY` is
checked at boot, in `createHandler`.

**Fail-closed** is the failure case only: a wrong or missing key returns
`404`, which the client logs once at ERROR as `flytlv.feed_off` and surfaces as
"unavailable" to the caller. A `404` is a configuration state, not a
transient error — a retry-storm would not fix it — so it is logged once per
instance and not retried. Other 4xx/5xx and timeouts are surfaced as separate
caller-friendly errors. Timeouts are short and configurable
(`FLYTLV_TIMEOUT_MS`, with one retry on a timeout only). No
pool/refresh/cooldown machinery (that belongs to the flytlv.app side, not
this stateless function). Knowledge reused from the read-only
`reference/flytlv_app` client.

## Files

- `src/index.ts` — production entry: `node:http` server. Wires the real deps,
  choosing `EdgeActor` (`USE_SHARED_ACTOR=true`, default) or `ActorClient`
  (HTTP facade) inside `buildDependencies()`.
- `src/server.ts` — `createServer(kv, actor, fetch, sms?, m?)` (the four
  tools + zod schemas; `send_deal_sms` only when an SMS sender is wired) and
  `createHandler(deps)` (auth + health + per-request MCP). The `actor` dep is
  the `Actor` interface — both `EdgeActor` and `ActorClient` satisfy it.
  Also `slim()` and the `Kv` / `KvError` contracts.
- `src/flytlv.ts` — flytlv.app deals API client (`FlytlvClient` / `FlytlvError`).
- `src/actor.ts` — `Actor` interface plus two implementations:
  `ActorClient` (HTTP facade, used by the Python webhook) and `EdgeActor`
  (direct `env.SESSIONS` binding, used by this service in production). Plus
  `ActorError` / `ActorInputError` and `ActorMetrics` (one batched
  `/metrics/add` per request).
- `src/kv.ts` — thin JSON wrapper over the `env.KV` Edge binding (`EdgeKv`).
- `src/config.ts` — lazy env reading (`require` / `optional` / `integer` / `flag`).
- `src/log.ts` — structured JSON logging: Israel-time `ts`, per-request `trace_id` (AsyncLocalStorage).
- `src/sms.ts` — sends a deal by SMS through the `env.TELNYX` binding (alphanumeric sender `FlyTLV`).
- `func.toml` — Edge manifest: `[edge_compute]` id/name, `[storage.kv.KV]`
  binding, `[[actors]]` `SESSIONS` binding for the shared `CallerSession`,
  and `[env_vars]` (incl. `USE_SHARED_ACTOR`).
- `package.json` / `tsconfig.json` — `npm run build` (tsc → `dist/`), `npm start`, `npm test`.

## Configuration

Everything from env vars / Edge secrets — nothing hardcoded:
`MCP_API_KEY`, `FLYTLV_API_KEY`, `ACTOR_SERVICE_URL`, `INTERNAL_API_TOKEN`
(secrets; `ACTOR_SERVICE_URL` and `INTERNAL_API_TOKEN` only required when
`USE_SHARED_ACTOR=false`); `MCP_SERVER_NAME`, `USE_SHARED_ACTOR`,
`FLYTLV_API_BASE`, `FLYTLV_DEALS_PATH`, `FLYTLV_API_KEY_HEADER`,
`FLYTLV_TIMEOUT_MS`, `DEALS_FETCH_LIMIT`, `DEALS_RESULT_LIMIT`,
`DEALS_CACHE_TTL`, `DEALS_CACHE_PREFIX`, `SESSION_KEY_PREFIX`,
`HTTP_TIMEOUT_MS`, `TRACE_HEADER`, `LOG_LEVEL` (`func.toml` `[env_vars]`).

Itinerary + reminder config — `SMS_FROM`, `MESSAGING_PROFILE_ID`,
`ITINERARY_BASE_URL`, `REMINDER_DELAY_SECONDS` (`func.toml` `[env_vars]`).
Forwarded on every `saveDeal` actor call in `config` (step 11): the actor's
umbrella `telnyx.toml [env_vars]` do not reach actor instances'
`process.env`, while this function's `func.toml [env_vars]` do — so the
itinerary base URL, reminder delay and SMS sender/profile are read here
and shipped over the actor RPC on every save (see "## Itinerary + reminder
config travels with the call" below).

## KV usage

`src/kv.ts` uses `env.KV` (the binding declared as `[storage.kv.KV]` in
`func.toml`):

- `session/<conversation_id>` → `{ entity_id }` (written by the webhook).
- `cache/deals/<query>` → the full flytlv payload (TTL `DEALS_CACHE_TTL`),
  re-slimmed on a cache hit without another upstream call.

## Observability

Structured JSON logs (`src/log.ts`): `mcp.search_deals` / `mcp.save_deal` /
`mcp.list_saved_deals` INFO spans with `trace_id` (= `telnyx_conversation_id`),
plus `flytlv.feed_off` ERROR (once per instance) and `mcp.session_read_failed`
/ `mcp.remember_failed` ERROR (with stack). A WARNING `mcp.actor.http_fallback`
is emitted on boot when `USE_SHARED_ACTOR=false`.

## Test & deploy

`fde-mcp` is already registered: `func_id = "bc3393fa-a5f2-4470-b7af-137f3d9c831d"`
(pinned in `func.toml` under `[edge_compute]`).

```bash
cd services/mcp-server
npm install
npm run build
npm test          # tests/test_mcp.test.mts (node:test via tsx)
telnyx-edge ship --from-dir services/mcp-server
```
