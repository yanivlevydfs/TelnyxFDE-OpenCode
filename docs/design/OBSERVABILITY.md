# Observability

## What is instrumented

| Signal | Where | How to read it |
| --- | --- | --- |
| Structured JSON logs | All services (`shared/common.py`, `session-actor/src/index.ts`) | `telnyx-edge logs <fn> --type runtime --json --tail` |
| Latency spans (`duration_ms`) | One per request: `webhook.request`, `mcp.request` (with the tool name), `actor.request` | `jq 'select(.duration_ms)'` |
| Distributed trace id (`trace_id`) | Webhook → actor, MCP → actor (`x-trace-id` header) | one id per conversation |
| Platform metrics (count, 2xx/4xx/5xx, p50/p95/p99) | Edge built-in | `telnyx-edge metrics <fn>` / `telnyx-edge actors metrics CallerSession` |
| Degraded-mode flag | webhook response + log `outcome: "degraded"` | `backend_degraded` dynamic variable |
| Service metrics (counters + latency) | `MetricsCounter` Stateful Actor, one batched update per request from the webhook and the MCP server | `python scripts/ops/metrics.py` (`metrics.snapshot` JSON line: counts, degraded rate, cache hit rate, latency) |

Every `ts` is in Israel time (`LOG_TIMEZONE`, default `Asia/Jerusalem`), ISO 8601
with the offset, e.g. `2026-10-07T01:30:15.610+03:00`.

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

### The metrics caught a live bug

After the metrics actor went live, one snapshot showed `webhook.calls 17`,
`webhook.degraded 17`, `webhook.failed.session 17`, and `webhook.request` averaging
1206 ms, exactly the 1.2 s budget. The webhook logs named the cause:
`dependency budget exceeded (1.2s)` for the flags read and the session write.
Timing Telnyx KV over REST directly gave 1.2-3.7 s per read and ~2 s per write.
Fix: the session write moved after the response, flags are cached for 60 s, and
only the actor call stays in the (2.5 s) budget.

## New log events from steps 7-11

Steps 7-11 added the itinerary file in Cloud Storage, the actor-alarm reminder
SMS, the shared-actor binding, and the per-call config that works around the
umbrella-[env_vars] bug. The structured JSON log events those changes emit
(all on `fde-session-actor` unless noted), and what each tells an on-call
engineer:

| Event | Level | Service | What it tells on-call |
| --- | --- | --- | --- |
| `itinerary_skipped` | WARNING | `fde-session-actor` | `saveDeal` did not write the itinerary file. The `reason` field is `noITINERARIES` (the `[storage.cloudstorage.ITINERARIES]` binding is missing on this deploy), `noITINERARY_BASE_URL` (the public URL prefix is not configured — this is the live bug from step 11), or `noSetAlarm` (the ctx has no `setAlarm`, e.g. a unit test environment). The save still succeeded; only `itineraryUrl` is dropped from the profile. Storm of these in production = the binding or env-var drifted. |
| `itinerary_write_failed` | WARNING | `fde-session-actor` | `bucket.put` threw (network/permission/quota). `dealId` and the `error` text are logged. The save still succeeded. A persistent stream means the bucket binding is misconfigured or the region is wrong; a one-off is transient. |
| `itinerary.read_failed` | ERROR | `fde-session-actor` | The public `GET /itineraries/<uuid>.html` route failed to read the object back. `key` and `error` are logged. A 500 back to the caller; investigate the bucket binding. |
| `reminder_scheduled` | INFO | `fde-session-actor` | `saveDeal` armed the alarm (`delay_ms` in the payload). The reminder is now pending; `alarm()` will fire in `delay_ms`. Useful for tracing save → reminder latency. |
| `alarm.sms_sent` | INFO | `fde-session-actor` | The follow-up reminder SMS was delivered to Telnyx. The pending reminder is drained, so a redrive sends nothing. This is the success signal for the whole step-7 reminder feature. |
| `alarm.failed` | ERROR | `fde-session-actor` | Any uncaught error inside `alarm()`. `error` and `stack` are logged. The reminder is **not** drained (left for a redrive) unless it was already — see `alarm.sms_sent`. Three redrives drop the alarm; persistent `alarm.failed` means the SMS provider or the actor storage is degraded. |
| `alarm.sms_config_missing` | WARNING | `fde-session-actor` | `alarm()` had no way to send the reminder: `env.TELNYX` binding, `smsFrom` or `messagingProfileId` all missing (the values the MCP server forwards in `config`; the actor itself cannot read them from `process.env` — decision #28). The reminder is drained to stop the alarm cycling. Indicates a config gap (MCP `func.toml` lost the values, or the `TELNYX` binding changed). |
| `alarm.deal_missing` | WARNING | `fde-session-actor` | The reminder points at a `dealId` no longer in `savedDeals` (caller saved it, then a newer save overwrote the actor state — `MAX_SAVED_DEALS` eviction, or the caller is testing). Reminder drained; not an error. |
| `alarm_schedule_failed` | WARNING | `fde-session-actor` | `setAlarm` itself threw (e.g. the actor runtime rejected it). The reminder is drained. Rare; points at the actor runtime. |
| `mcp.actor.http_fallback` | WARNING | `fde-mcp` | `USE_SHARED_ACTOR=false` was set, so the MCP server is going through the session-actor HTTP facade (`ActorClient`) instead of the `SESSIONS` binding. Not an error; intentional for local debugging. Unexpected in production = the `SESSIONS` binding declaration is missing or broken in `func.toml`. |

The related span `actor.request` (one per facade call) timestamps and times
both the inbound `saveDeal` and the outbound `alarm()` turn, so the
`reminder_scheduled → alarm.sms_sent` distance is measurable end-to-end.

Cheat-sheet for triage:

- Reminder never arrives: search for `reminder_scheduled` (did `saveDeal` arm
  the alarm?); if present, look for `alarm.sms_sent`, `alarm.failed`,
  `alarm.sms_config_missing`, `alarm.deal_missing` shortly after
  `REMINDER_DELAY_SECONDS`.
- No itinerary URL on a save: search for `itinerary_skipped` /
  `itinerary_write_failed` on that `entity` (last-4 of phone).
- MCP server falls off the shared actor: `mcp.actor.http_fallback` once per
  cold start; service otherwise keeps working over HTTP.

## Step 22 log events — bucket object limit

The `flytlv-itineraries` Cloud Storage bucket has a hard account limit of
at most 5 objects (owner, 2026-10-08). Step 22 changed the code to write a
FIXED set of keys (4 itinerary slots + 1 audit object) and overwrite them
in place, never growing. The log events those changes emit:

| Event | Level | Service | What it tells on-call |
| --- | --- | --- | --- |
| `config.clamp_slots` | ERROR | `fde-session-actor` | The env config violates the guard `ITINERARY_SLOTS + 1 <= STORAGE_MAX_OBJECTS`: the code refused the broken value, logged its `requested` and `maxObjects`, and clamped slots to `maxObjects - 1`. Fix the env vars in `telnyx.toml` / MCP `func.toml` so the actor and the facade agree on the slot count. |
| `itinerary_write_failed` | WARNING | `fde-session-actor` | `bucket.put` threw on a slot key. Seen live as `HTTP 400: TooManyObjects` before step 22 (the bucket grew past 5 objects). After step 22 this should ONLY appear transiently (network/permission). A persistent stream means the bucket binding, the region, or the slot config is wrong. |
| `audit_write_failed` | ERROR | `fde-session-actor` | The `AuditLog` actor's `bucket.put("audit/latest.json")` threw. `AUDIT_ENABLED` must be true and the `AUDIT_LOG` binding must be present. The failure logged here is in the AuditLog actor (it caught the error internally and returned `{ok: true}`); the caller's tool call was never affected. |

**Itinerary slot design signoff**: with the fixed-key design, the bucket key
count is at most `ITINERARY_SLOTS + 1 = 5` forever, regardless of how many
callers or events pass through. `scripts/ops/storage_check.py` lists the
bucket over S3 (sigv4) and fails on any key outside
`{itineraries/slot-<n>.html, audit/latest.json}` or on a count > `STORAGE_MAX_OBJECTS`.
