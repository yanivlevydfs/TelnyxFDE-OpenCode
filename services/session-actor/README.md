# `services/session-actor` — CallerSession Stateful Actor

The FlyTLV Travel Line keeps per-caller state in a Telnyx **Stateful Actor**: how
many times the caller phoned, what deals were spoken to them on this call, and
which deals they chose to save. The next call opens with a greeting built from
that history ("Welcome back, last time you saved Larnaca for 64 dollars").

Stateful Actors on Telnyx Edge are TypeScript-only and have no native HTTP
surface, so this service is the **thin TypeScript facade** the Python services
(webhook, mcp-server) call from outside.

## Files

| File | Purpose |
|---|---|
| `src/caller-session.ts` | `CallerSession extends StatefulActor<Env>` — `recordCall`, `getProfile`, `setLastResults`, `saveDeal`, `getSaved`. Exports the `Deal`/`Profile`/`ActorInputError` types. |
| `src/index.ts` | The Worker default export `worker.fetch(req, env)` — Bearer-guarded HTTP facade: `POST /actors/{caller}/{method}` (method allowlist) to `CallerSession`, and `POST /metrics/{add,snapshot,reset}` to the shared `MetricsCounter`. |
| `src/metrics-counter.ts` | `MetricsCounter extends StatefulActor` — one `global` instance holding service counters and latency (`add`, `snapshot`, `reset`). |
| `src/log.ts` | One structured JSON logger for the actor and facade: Israel-time `ts`, per-request `trace_id`, masked caller ids. |
| `telnyx.toml` | Umbrella manifest — `[[actors]] CALLER_SESSION → CallerSession`, `[[actors]] METRICS → MetricsCounter`, a `[[secrets]]` binding for `INTERNAL_API_TOKEN`, and the `[edge_compute] func_id`. |
| `package.json`, `tsconfig.json` | NPM + TypeScript config. |

## Why an actor (and not KV) for this state

The actor owns three per-caller pieces of state that all need **atomic
read-modify-write**:

  - `callCount`   — incremented on every webhook fire (one per call)
  - `lastResults` — the deals spoken to this caller on this call, so
                    `save_deal` can only save a deal they were actually offered
                    (the model cannot invent one)
  - `savedDeals`  — append-only set, deduped by `dealId`

KV on Telnyx is last-write-wins with no compare-and-set, so two concurrent
calls from the same caller (e.g. a re-dial while the first call is still
finishing) would race and lose updates. A Telnyx Stateful Actor serializes
each instance's method turns one at a time, which is the lock we want for
free. The actor is the right primitive here, KV is not. See
`docs/design/DECISIONS.md` (#9, #13).

## API

All routes are `POST` with a JSON body; all responses are JSON.
Caller id is the digits of the phone (matches `entity_id` in
`shared/common.py`); actor names cannot contain `+`.

| Route | Body | Returns |
|---|---|---|
| `/actors/{callerId}/recordCall`     | *(ignored)*  | `{callCount, savedCount, lastSaved}` — full profile |
| `/actors/{callerId}/getProfile`    | *(ignored)*  | `{callCount, savedCount, lastSaved}` |
| `/actors/{callerId}/setLastResults`| `{deals: Deal[]}`         | `{stored: number}`  — replaces last search results |
| `/actors/{callerId}/saveDeal`      | `{dealId: string}`        | `{callCount, savedCount, lastSaved}` |
| `/actors/{callerId}/getSaved`      | *(ignored)*  | `{savedCount: number, deals: Deal[]}` |

`recordCall` returns the **full profile** (callCount, savedCount, lastSaved) on
purpose — the webhook builds `call_count`, `saved_count` and `last_saved_deal`
("welcome back, you saved …") from that one response.

### Errors

| Status | When |
|---|---|
| `401 {error}` | missing/wrong `Authorization: Bearer <INTERNAL_API_TOKEN>` |
| `404 {error}` | path does not match `/actors/{id}/{method}` |
| `405 {error}` | request is not `POST` |
| `400 {error}` | caller id is not all digits; method not in the allowlist; invalid JSON body; `ActorInputError` from the actor (missing `dealId`, deal not in last results, non-array `deals`) |
| `500 {error}` | any other unexpected failure (logged with stack) |

## Security (DECISIONS #8)

  - **Bearer token.** Read through `env.SECRETS.get("INTERNAL_API_TOKEN")`
    (Dapr-backed on Edge). `env.INTERNAL_API_TOKEN` is honoured for tests /
    local dev. The successful read is cached per-process (Edge pods scale to
    zero, so the cache never goes stale in production); a failed read is not
    cached so a transient Dapr blip self-heals.
  - **Caller id is digits only.** Matches `entity_id` from `common.py`
    (phones stripped to digits) and the platform rule "actor names cannot
    contain '+'".
  - **Method allowlist.** Exactly the five public methods above; nothing else
    on the actor is reachable over HTTP (least privilege).
  - **Auth precedes routing reasons.** An unauthenticated caller receives
    `401` regardless of how malformed the rest of the request is.

## Logging

One JSON line per event to `console` with `{ts, level, service, event, ...}`,
where `level` is `DEBUG`/`INFO`/`WARNING`/`ERROR` (matches the Python
services). The level is configurable via `LOG_LEVEL` (default `INFO`).

```json
{"ts":"2026-10-06T12:00:00.000Z","level":"INFO","service":"session-actor","event":"recordCall","entity":"97250","callCount":3}
```

Errors carry an `error` and a `stack`:

```json
{"ts":"…","level":"ERROR","service":"session-actor","event":"dispatch_failed","entity":"97250","method":"saveDeal","error":"…","stack":"…"}
```

## Test

```bash
cd services/session-actor
npm install
npm test
```

The test (`UnitTest/test_session_actor.test.mts`) injects an in-memory fake
`ctx.storage` and a fake `env.SECRETS.get → "tok"`. It runs with the Node
built-in test runner via `tsx`. Only the unit layer uses fakes — every other
service talks to a real Telnyx actor.

## Deploy

```bash
# The shared bearer the Python services also send:
telnyx-edge secrets add INTERNAL_API_TOKEN <value>

cd services/session-actor
telnyx-edge ship
```

`ship` bundles `src/index.ts` (which re-exports `CallerSession`) and uploads
under the umbrella `name = "fde-session-actor"` declared in `telnyx.toml`.
