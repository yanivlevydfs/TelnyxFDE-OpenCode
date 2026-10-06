# shared — common Python code, vendored into each Edge Function

The single source of truth for Python code reused across the Edge Function
services (`webhook`, `mcp-server`). Not an Edge service itself.

## Why one file

Telnyx Edge builds each function folder alone — there is no shared package
import across services. So every reusable helper lives in **one** file,
`shared/common.py`, and `scripts/vendor_shared.py` copies it into each Python
service as `function/common.py` before `telnyx-edge ship` (or tests). One source
of truth, no copy-paste (owner's rule #2). Re-run the vendor after any edit:

```bash
python scripts/vendor_shared.py
```

TypeScript services (`services/session-actor`) have no `function/` directory and
are skipped automatically.

## What is in `common.py`

| Section | Provides |
|---|---|
| **config** | `require` / `optional` / `integer` / `flag` env helpers, `ConfigError`. Fails loudly on missing/invalid settings so a broken deploy shows up at boot, not mid-call. |
| **logging** | `info` / `warning` / `error` / `debug`; one JSON object per line (`level`, `event`, `trace_id`, fields, traceback). `timed(span)` context manager emits a latency `span` with `duration_ms` and `outcome`. `_trace_id` is mirrored onto the shared `common` logger object so every vendored copy sees the latest id. `LOG_LEVEL` env var. Uses `print()` via `_StdoutHandler` so pytest's `capsys` captures lines. |
| **KV** | `Kv(client)` async JSON wrapper over `telnyx.storage.kvs.keys` (REST; Python has no KV `env` binding). `get_json` returns `None` for a missing key (`telnyx.NotFoundError`), `KvError` otherwise. `put_json` with optional `ttl_secs`. |
| **actor client** | `ActorClient(http)` — POSTs JSON to `{ACTOR_SERVICE_URL}/actors/{entity_id}/{method}` with `Bearer INTERNAL_API_TOKEN` and the outbound `x-trace-id` (name from `TRACE_HEADER`). `4xx → ActorInputError`, `5xx/network → ActorError`. |
| **sessions** | `save_session(kv, conv_id, phone)` / `load_session(kv, conv_id)` — the conversation→caller KV mapping with a TTL (`SESSION_TTL`, default 1 h). |
| **phone** | `entity_id(phone)` — digits only (the actor `idFromName` input; "actor names cannot contain '+'"). `mask(phone)` — last 4 digits after `***` for logs. |

## Distributed tracing

`set_trace_id(tid)` stores the `telnyx_conversation_id` (fallback
`call_control_id`) into the shared logger and the outbound request header, so a
single call can be followed across webhook → actor → MCP with one id:
`telnyx-edge logs <fn> --json | jq 'select(.trace_id=="<id>")'`.

## Design notes for the vendored copies

A subtlety the code handles: the webhook and mcp-server each get their own
_vendored_ copy of `common.py` (distinct module objects in one test process).
The JSON formatter, the stdout handler, and the trace id live on the shared
`logging.getLogger("common")` object and are compared by class **name**, so all
copies share one handler, one formatter, and one live trace id — no double
logging and no stale id.

## Test

```bash
.venv/Scripts/python -m pytest UnitTest/test_common.py -q   # this module (13 tests)
.venv/Scripts/python -m pytest UnitTest -q                   # whole suite
```

The tests pass fakes for the `telnyx` client and `httpx`, and rely on `capsys`
capturing the `print()`-based JSON logs.

## Built by

OpenCode · **GLM-5.2** (`telnyx/zai-org/GLM-5.2`). See the root
[README.md](../README.md#which-model-built-each-component).
