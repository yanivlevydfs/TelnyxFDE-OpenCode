# Observability

## What is instrumented

| Signal | Where | How to read it |
|---|---|---|
| Structured JSON logs | All services (`shared/common.py`, `session-actor/src/index.ts`) | `telnyx-edge logs <fn> --type runtime --json --tail` |
| Latency spans (`event: "span"`, `duration_ms`) | Every KV call, actor call, MCP tool, whole webhook request | filter `span` with `jq` |
| Distributed trace id (`trace_id`) | Webhook → actor → MCP | one id per conversation |
| Platform metrics (count, 2xx/4xx/5xx, p50/p95/p99) | Edge built-in | `telnyx-edge metrics <fn>` / `telnyx-edge actors metrics CallerSession` |
| Degraded-mode flag | webhook response + log `outcome: "degraded"` | `backend_degraded` dynamic variable |

### Log line shape

```json
{"ts":"2026-10-04T12:00:00Z","level":"info","service":"webhook","event":"span",
 "trace_id":"<telnyx_conversation_id>","span":"webhook.request","duration_ms":212.4,
 "outcome":"ok","caller":"***0100","assistant_id":"...","degraded":[]}
```

Caller numbers are masked to the last 4 digits.

### Trace correlation

The webhook sets `trace_id` to `telnyx_conversation_id` (fallback `call_control_id`).
Telnyx sends the same conversation id to the MCP server in `params._meta`, so every
MCP tool span carries the same `trace_id`. Both Python services forward it to the actor
service in the `x-trace-id` header (configurable via `TRACE_HEADER`).

```bash
# Reconstruct one call end to end
for fn in fde-webhook fde-mcp fde-session-actor; do
  telnyx-edge logs $fn --type runtime --json --since 1h
done | jq -c 'select(.trace_id=="<conversation-id>")'
```

## How I'd know within a minute that the assistant is broken

1. `telnyx-edge metrics fde-webhook` — 4xx/5xx count rising or p95 approaching the
   webhook timeout. Every call hits the webhook first, so it is the canary.
2. `telnyx-edge logs fde-webhook --tail --json | jq 'select(.outcome!="ok")'` —
   `rejected` = signature/key problem, `degraded` = KV or actor down, `dependency.timeout`
   = slow dependency.
3. Follow the `trace_id` into `fde-session-actor` and `fde-mcp` logs.

Alert export (optional): `telnyx-edge log-export set <fn> --endpoint <OTLP> --header k=v`.

## Debugging trail

_To be filled in during development: one real bug, the signal that exposed it, and the fix._
