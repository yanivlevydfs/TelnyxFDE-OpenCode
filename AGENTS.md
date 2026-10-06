# AGENTS.md — instructions for the AI coding agent (OpenCode + Telnyx Inference)

You are building the Telnyx FDE coding challenge solution described in `code_challenge.md`.
Follow it strictly. The design is in `spec/`. The acceptance tests are in `UnitTest/` —
**the job is done when every test passes**. Do not edit the tests to make them pass.

## Product: FlyTLV Travel Line

A caller phones a Telnyx AI Assistant, asks for cheap round-trip flights from Tel Aviv, hears
the best deals from the flytlv.app deals API, can save one, and on the next call hears
"welcome back, you saved …".

flytlv API: `GET {FLYTLV_API_BASE}/api/private/deals` with header `X-API-Key`. Params:
`destination` (IATA), `max_price`, `departure_date`, `stops` ("0" = direct), `sort=cheapest`,
`one_per_destination`, `limit`. Returns `{currency, deals: [{deal_id, price, departure_date,
return_date, airline, is_direct, deal_url, destination_airport: {city, country}}]}`.
A wrong key returns **404**.

## Owner's rules (mandatory)

1. Every component is a separate microservice with its own folder and files.
2. Reuse code: shared Python code lives in ONE file, `shared/common.py`, copied into each
   service as `function/common.py` by `scripts/vendor_shared.py`. Never copy-paste.
3. Nothing hardcoded: every value comes from environment variables / Telnyx Edge secrets.
4. Comment and document the code; a README per component.
5. Python everywhere, except the Stateful Actor (Telnyx Actors are TypeScript-only) and the
   MCP server (Edge builds Python 3.9; the Python `mcp` SDK needs 3.10+).
6. Short, clean, readable code. Prefer official SDKs over hand-written code.
7. Structured JSON logging with INFO / WARNING / ERROR (traceback on errors) and proper
   exception handling everywhere.
8. **Everything uses Telnyx**: Telnyx KV and the Stateful Actor on Telnyx Edge. No local
   stand-ins. Only unit tests use fakes.

## Target structure (the tests import these paths)

```
shared/common.py                     config, JSON logging, Kv, ActorClient, sessions, phone
services/webhook/function/func.py    Dynamic Variables webhook (Edge Function, Python)
services/mcp-server/src/          MCP server, 4 tools (Edge Function, TypeScript)
services/session-actor/src/          CallerSession Stateful Actor + HTTP facade (TypeScript)
assistant/flow.py, provision.py      Assistant + Conversation Workflow via the Telnyx SDK
scripts/vendor_shared.py             copy shared/common.py into each Python service
```

Read the tests first: they define the exact function names, classes, variables and behaviour
(e.g. `create_app(client, kv, actor)`, `createServer(kv, actor, fetch)`, `slim()`,
`Function`, `new()`, `build_flow()`, `validate()`, `build_tools()`, `assistant_body()`).

## Platform facts (verified)

- Telnyx Python SDK pinned: `telnyx==4.182.0`. KV: `client.storage.kvs.keys.retrieve/update`
  (`telnyx.NotFoundError` = missing key). Webhook signatures: `client.webhooks.unwrap(body, headers=...)`.
  It raises a `ValueError` subclass on a bad/stale signature — check the signature BEFORE parsing JSON.
- Edge Python contract: `function/func.py` exposes `new()` returning an object with
  `async handle(scope, receive, send)` (ASGI). Dependencies in `pyproject.toml` (hatchling,
  `[project] name = "function"` as the `telnyx-edge new-func -l python` scaffold does).
- `func.toml` official format (docs: /docs/edge-compute/configuration). There are NO `name`,
  `runtime` or `entry` keys:

  ```toml
  [edge_compute]
  func_id = "<uuid written by telnyx-edge new-func>"
  func_name = "<name>"
  [telnyx]
  binding = "TELNYX"        # string handle; injects TELNYX_API_KEY
  [env_vars]                # non-secret strings only; secrets via `telnyx-edge secrets add`
  ```

- Registered functions: `fde-webhook` func_id `e5907143-e572-4e86-8880-0de76f057561`,
  `fde-mcp` func_id `bc3393fa-a5f2-4470-b7af-137f3d9c831d`. The actor service uses
  `telnyx.toml` (umbrella: `name`, `main`, `compatibility_date`, `[[actors]]`) and needs no func_id.
- Webhook ↔ actor contract: `recordCall` must return the full profile
  (`callCount`, `savedCount`, `lastSaved`), because the webhook builds `saved_count` and
  `last_saved_deal` ("welcome back, you saved …") from that one response.
- MCP: official TypeScript SDK `@modelcontextprotocol/sdk` (`McpServer`). A fresh server +
  stateless `StreamableHTTPServerTransport` (JSON responses) per request; KV via the `env.KV` binding. Telnyx sends the conversation id in `params._meta.telnyx_conversation_id`.
- Dynamic variables webhook: Telnyx POSTs once at call start; reply `{"dynamic_variables": {...}}`,
  string values only; default timeout 1.5 s → run KV + actor calls in parallel under a budget and
  return safe defaults with `backend_degraded="true"` on failure.
- Actor: umbrella `telnyx.toml` with `[[actors]]`; `env.CALLER_SESSION.idFromName(digits)`;
  actor names cannot contain "+". Package `@telnyx/edge-runtime`.
- Workflow schema: `conversation_flow = {start_node_id, nodes, edges}`; node types `prompt`,
  `speak` (exactly one default edge), `tool`; edge `{id, start_node_id, target:{type:"node",node_id},
  condition}` with condition `llm` / `expression` / `default`.

## Workflow for the agent

Work one component at a time: shared → webhook → mcp-server → session-actor → assistant.
After each one run its tests (`.venv/Scripts/python -m pytest UnitTest/<file> -q`, or `npm test`
in services/session-actor) and fix the code until they pass. Commit after each green component.
