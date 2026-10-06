# mcp-server — MCP tools for the FlyTLV Travel Line

Python Telnyx Edge Function exposing three MCP tools the Telnyx AI Assistant
calls mid-conversation over stateless Streamable HTTP:
`search_deals`, `save_deal`, `list_saved_deals`.

## Request flow

1. **Bearer auth** — `Function.handle` checks `Authorization: Bearer <MCP_API_KEY>`
   before the MCP session manager sees the request. Mismatch → `401` JSON.
2. A per-request `StreamableHTTPSessionManager(app=server._lowlevel_server,
   stateless=True, json_response=True)` handles one JSON-RPC message (Edge has
   no ASGI lifespan).
3. Each tool resolves the caller from `session/<telnyx_conversation_id>` in KV
   (written by the webhook), then calls the flytlv deals API (KV-cached) and/or
   the caller's Stateful Actor, forwarding the same `trace_id`.

## Tools

| Tool | What it does | Actor method |
|---|---|---|
| `search_deals` | Query flytlv (KV-cached), speak deals back, remember them | `setLastResults` |
| `save_deal` | Save one of the last-shown deals (actor validates the choice) | `saveDeal` |
| `list_saved_deals` | Read the deals saved on previous calls | `getSavedDeals` |

Tool failures raise `ToolError` → the LLM gets `isError: true` with a
caller-friendly message (never a traceback, URL or API key).

### Why remembering matters (decision #13)

`search_deals` stores the deals it read aloud on the caller's actor via
`setLastResults`; `save_deal` may only save a deal the caller was actually
offered — the model cannot invent a price or URL.

## flytlv client (`flytlv.py`)

Minimal async client for `GET {FLYTLV_API_BASE}/api/private/deals` with an
`X-API-Key` header. The feed is **fail-closed**: a `404` means the key is
unset/rejected or the feed is off — logged once at ERROR and surfaced as
"unavailable" to the caller. Timeouts are short and configurable
(`FLYTLV_TIMEOUT_MS`). No pool/refresh/cooldown machinery (that belongs to the
flytlv.app side, not this stateless function). Knowledge reused from the
read-only `reference/flytlv_app` client.

## Files

- `function/func.py` — tools, helpers, bearer auth, ASGI entry point, `new()`.
- `function/flytlv.py` — flytlv.app deals API client for one tool call.
- `function/common.py` — vendored `shared/common.py` (`python scripts/vendor_shared.py`).
- `pyproject.toml` — Edge-installed dependencies (hatchling).
- `func.toml` — Edge manifest: `[edge_compute]` id/name, `[telnyx]` binding, `[env_vars]`.

## Configuration

Everything from env vars / Edge secrets — nothing hardcoded:
`MCP_API_KEY`, `FLYTLV_API_KEY`, `KV_NAMESPACE_ID`, `ACTOR_SERVICE_URL`,
`INTERNAL_API_TOKEN` (secrets); `MCP_SERVER_NAME`, `FLYTLV_API_BASE`,
`FLYTLV_DEALS_PATH`, `FLYTLV_API_KEY_HEADER`, `FLYTLV_TIMEOUT_MS`,
`DEALS_FETCH_LIMIT`, `DEALS_RESULT_LIMIT`, `DEALS_CACHE_TTL`,
`DEALS_CACHE_PREFIX`, `SESSION_KEY_PREFIX`, `HTTP_TIMEOUT_MS`, `TRACE_HEADER`,
`LOG_LEVEL` (`func.toml`).

## Observability

Structured JSON logs via `common`: `mcp.search_deals` / `mcp.save_deal` /
`mcp.list_saved_deals` INFO spans with `trace_id` (= `telnyx_conversation_id`),
plus `flytlv.feed_off` ERROR (once per instance) and `mcp.session_read_failed`
/ `mcp.remember_failed` ERROR (with traceback).

## Test & deploy

`fde-mcp` is already registered: `func_id = "bc3393fa-a5f2-4470-b7af-137f3d9c831d"`
(pinned in `func.toml` under `[edge_compute]`).

```bash
python scripts/vendor_shared.py
.venv/Scripts/python -m pytest UnitTest/test_mcp.py -q
telnyx-edge ship --from-dir services/mcp-server
```
