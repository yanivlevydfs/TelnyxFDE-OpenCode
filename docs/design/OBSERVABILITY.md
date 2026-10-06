# Observability

## What is instrumented

| Signal | Where | How to read it |
|---|---|---|
| Structured JSON logs | All services (`shared/common.py`, `session-actor/src/index.ts`) | `telnyx-edge logs <fn> --type runtime --json --tail` |
| Latency spans (`duration_ms`) | One per request: `webhook.request`, `mcp.request` (with the tool name), `actor.request` | `jq 'select(.duration_ms)'` |
| Distributed trace id (`trace_id`) | Webhook → actor, MCP → actor (`x-trace-id` header) | one id per conversation |
| Platform metrics (count, 2xx/4xx/5xx, p50/p95/p99) | Edge built-in | `telnyx-edge metrics <fn>` / `telnyx-edge actors metrics CallerSession` |
| Degraded-mode flag | webhook response + log `outcome: "degraded"` | `backend_degraded` dynamic variable |

### Log line shape

```json
{"level":"INFO","event":"webhook.request","trace_id":"<telnyx_conversation_id>",
 "span":"webhook.request","duration_ms":212,"outcome":"ok","caller":"***0100","degraded":[]}
{"ts":"...","level":"INFO","service":"fde-mcp","event":"mcp.request","trace_id":"<id>",
 "method":"tools/call","tool":"search_deals","status":200,"duration_ms":1840}
{"ts":"...","level":"INFO","service":"session-actor","event":"actor.request","trace_id":"<id>",
 "entity":"***4567","method":"setLastResults","status":200,"duration_ms":95}
```

Caller numbers are masked to the last 4 digits.

### Trace correlation

The webhook sets `trace_id` to `telnyx_conversation_id` (fallback `call_control_id`).
Telnyx sends the same conversation id to the MCP server in `params._meta`, so every
MCP tool span carries the same `trace_id`. The webhook and the MCP server forward it to the actor
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

Five real bugs, each with the log line or record that exposed it, are in the README:
[What broke during development, and how I found it](../../README.md#what-broke-during-development-and-how-i-found-it).
