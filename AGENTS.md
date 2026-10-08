# AGENTS.md — instructions for the AI coding agent (OpenCode + Telnyx Inference)

You are building the Telnyx FDE coding challenge solution described in `docs/challenge/code_challenge.md`.
Follow it strictly. The design is in `docs/design/`. The acceptance tests are in `tests/` —
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
   service as `function/common.py` by `scripts/build/vendor_shared.py`. Never copy-paste.
3. Nothing hardcoded: every value comes from environment variables / Telnyx Edge secrets.
4. Comment and document the code; a README per component.
5. Python everywhere, except the Stateful Actor (Telnyx Actors are TypeScript-only) and the
   MCP server (Edge builds Python 3.9; the Python `mcp` SDK needs 3.10+).
6. Short, clean, readable code. Prefer official SDKs over hand-written code.
7. Structured JSON logging with INFO / WARNING / ERROR (traceback on errors) and proper
   exception handling everywhere.
8. **Everything uses Telnyx**: Telnyx KV and the Stateful Actor on Telnyx Edge. No local
   stand-ins. Only unit tests use fakes.

## Repository structure

The tests import `shared/`, `services/`, `assistant/` and `tests/` paths, so
those stay where they are.

```
services/                            LIVE on Telnyx Edge (shipped by .github/workflows/ship.yml)
  webhook/function/func.py           Dynamic Variables webhook (Edge Function, Python)
  mcp-server/src/                    MCP server, 4 tools (Edge Function, TypeScript)
  session-actor/src/                 CallerSession + MetricsCounter Stateful Actors + HTTP facade (TypeScript)
shared/common.py                     config, JSON logging, Kv, ActorClient, sessions, phone
assistant/flow.py, provision.py      PROVISIONING: workflow + assistant via the Telnyx SDK
scripts/build/vendor_shared.py       copy shared/common.py into each Python service
scripts/ops/                         live_check.py, metrics.py, actor_concurrency_check.py
docs/challenge/                      code_challenge.md (the brief), USE_CASE.md
docs/design/                         ARCHITECTURE, DECISIONS, OBSERVABILITY
docs/guides/                         HOW_TO_CALL (callers), INTEGRATION (engineers)
docs/presentation/                   PRESENTATION (deck slides), DEMO_SCRIPT (demo), README, deck/
docs/build/PROMPTS.md, DOGFOODING.md OpenCode build prompts; dogfooding notes
tests/                            acceptance tests (do not edit) + check_* self-checks
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
- Actor alarms (`ctx.storage.setAlarm(ms) / getAlarm() / deleteAlarm()`): one
  alarm per instance, at-least-once delivery, dropped after 3 redrives
  (`import type { AlarmInfo } from "@telnyx/edge-runtime"`). A throw from
  `alarm()` loses the alarm after the redrives — always catch, log `ERROR` with
  the stack, and return.
- Cloud Storage binding (`[storage.cloudstorage.<NAME>]` in `telnyx.toml`,
  `bucket_name` + `region`): `await env.<NAME>.put(key, body, { httpMetadata:
  { contentType } })`, `const obj = await env.<NAME>.get(key)` returns
  `{ body: ReadableStream, writeHttpMetadata(headers) }` or `null`. The bucket
  reaches actor instances; named env vars do not (next bullet).
- "Shared actors": one function owns the class and declares it with
  `[[actors]] binding = "<X>" type = "ClassName"`; another function on the
  same account declares the same `type` under its own `binding`
  (`[[actors]] binding = "<Y>" type = "ClassName"`) and **ships no class code**
  — the runtime forwards the call over an RPC hop to the owning function.
  Reference side calls `env.<Y>.idFromName(name)[method](body)`. Over the RPC
  hop an `ActorInputError` arrives as a plain `Error` whose message embeds
  `{"name":"ActorInputError","message":"..."}` — recover the marker to map
  it back to a 4xx-class error.
- Umbrella `telnyx.toml` `[env_vars]` **do not** reach actor instances'
  `process.env` (live finding, step 11: `itinerary_skipped
  reason=noITINERARY_BASE_URL`), while the Cloud Storage bucket binding
  (`[storage.cloudstorage.<NAME>]`) *does* and a function's own `func.toml`
  `[env_vars]` *do*. Work-around: the caller reads its own `[env_vars]` and
  forwards the values on the actor method's `body` (e.g. `config`), and the
  actor resolves `config.X ?? process.env.X` (`process.env` stays the fallback
  for unit tests, local dev, and once the platform honours the actor umbrella).

## Workflow for the agent

Work one component at a time: shared → webhook → mcp-server → session-actor → assistant.
After each one run its tests (`.venv/Scripts/python -m pytest tests/<file> -q`, or `npm test`
in services/session-actor) and fix the code until they pass. Commit after each green component.
