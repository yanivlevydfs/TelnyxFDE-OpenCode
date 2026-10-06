# mcp-server — MCP tools for the FlyTLV Travel Line

TypeScript Telnyx Edge Function exposing three MCP tools the Telnyx AI
Assistant calls mid-conversation over stateless Streamable HTTP:
`search_deals`, `save_deal`, `list_saved_deals`.

> **TypeScript, not Python.** Telnyx Edge builds Python with 3.9, but the
> official `@modelcontextprotocol/sdk` requires Python 3.10+ — so the Python
> MCP server cannot deploy. This service is the behaviour-identical TypeScript
> port (an Edge Function built on `node:http` + the MCP SDK).

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
|---|---|---|
| `search_deals` | Query flytlv (KV-cached), speak deals back, remember them | `setLastResults` |
| `save_deal` | Save one of the last-shown deals (actor validates the choice) | `saveDeal` |
| `list_saved_deals` | Read the deals saved on previous calls | `getSavedDeals` |

Tool failures return `{ content:[{type:"text",text:msg}], isError:true }` so the
LLM gets `isError: true` with a caller-friendly message (never a traceback,
URL or API key).

### Why remembering matters (decision #13)

`search_deals` stores the deals it read aloud on the caller's actor via
`setLastResults`; `save_deal` may only save a deal the caller was actually
offered — the model cannot invent a price or URL.

## flytlv client (`src/flytlv.ts`)

Minimal async client for `GET {FLYTLV_API_BASE}/api/private/deals` with an
`X-API-Key` header. The feed is **fail-closed**: a `404` means the key is
unset/rejected or the feed is off — logged once at ERROR and surfaced as
"unavailable" to the caller. Timeouts are short and configurable
(`FLYTLV_TIMEOUT_MS`). No pool/refresh/cooldown machinery (that belongs to
the flytlv.app side, not this stateless function). Knowledge reused from the
read-only `reference/flytlv_app` client.

## Files

- `src/index.ts` — production entry: `node:http` server, wires real deps, listens on `PORT || 8080`.
- `src/server.ts` — `createServer(kv, actor, fetchImpl, sms?, metrics?)` (4 tools + zod schemas; `send_deal_sms` only when an SMS sender is wired) and `createHandler(deps)` (auth + health + per-request MCP). Also `slim()` and the `Kv` / `KvError` contracts.
- `src/flytlv.ts` — flytlv.app deals API client (`FlytlvClient` / `FlytlvError`).
- `src/actor.ts` — HTTP client for the session-actor facade (`ActorClient` / `ActorError` / `ActorInputError`); 400 → input error with the message.
- `src/kv.ts` — thin JSON wrapper over the `env.KV` Edge binding (`EdgeKv`).
- `src/config.ts` — lazy env reading (`require` / `optional` / `integer` / `flag`).
- `src/log.ts` — structured JSON logging + per-request `trace_id`.
- `func.toml` — Edge manifest: `[edge_compute]` id/name, `[storage.kv.KV]` binding, `[env_vars]`.
- `package.json` / `tsconfig.json` — `npm run build` (tsc → `dist/`), `npm start`, `npm test`.

## Configuration

Everything from env vars / Edge secrets — nothing hardcoded:
`MCP_API_KEY`, `FLYTLV_API_KEY`, `ACTOR_SERVICE_URL`, `INTERNAL_API_TOKEN`
(secrets); `MCP_SERVER_NAME`, `FLYTLV_API_BASE`, `FLYTLV_DEALS_PATH`,
`FLYTLV_API_KEY_HEADER`, `FLYTLV_TIMEOUT_MS`, `DEALS_FETCH_LIMIT`,
`DEALS_RESULT_LIMIT`, `DEALS_CACHE_TTL`, `DEALS_CACHE_PREFIX`,
`SESSION_KEY_PREFIX`, `HTTP_TIMEOUT_MS`, `TRACE_HEADER`, `LOG_LEVEL`
(`func.toml` `[env_vars]`).

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
/ `mcp.remember_failed` ERROR (with stack).

## Test & deploy

`fde-mcp` is already registered: `func_id = "bc3393fa-a5f2-4470-b7af-137f3d9c831d"`
(pinned in `func.toml` under `[edge_compute]`).

```bash
cd services/mcp-server
npm install
npm run build
npm test          # UnitTest/test_mcp.test.mts (node:test via tsx)
telnyx-edge ship --from-dir services/mcp-server
```
