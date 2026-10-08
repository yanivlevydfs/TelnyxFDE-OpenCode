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
| --- | --- |
| `src/caller-session.ts` | `CallerSession extends StatefulActor<Env>` — `recordCall`, `getProfile`, `setLastResults`, `saveDeal`, `getSaved`, `getHistory`, and the `alarm()` override that fires the follow-up SMS. Renders the mobile-friendly itinerary HTML page written into Cloud Storage on every save; appends search/save history + audit on `setLastResults`/`saveDeal`. Exports the `Deal`/`Profile`/`HistoryEntry`/`ActorInputError`/`SessionActorEnv`/`renderItinerary` types. |
| `src/index.ts` | The Worker default export `worker.fetch(req, env)` — Bearer-guarded HTTP facade: `POST /actors/{caller}/{method}` (method allowlist: `recordCall`, `getProfile`, `setLastResults`, `saveDeal`, `getSaved`, `getHistory`) to `CallerSession`, and `POST /metrics/{add,snapshot,reset}` to the shared `MetricsCounter`; plus the public `GET /itineraries/<uuid>.html` route that streams the HTML page straight out of `env.ITINERARIES`. |
| `src/metrics-counter.ts` | `MetricsCounter extends StatefulActor` — one `global` instance holding service counters and latency (`add`, `snapshot`, `reset`). |
| `src/log.ts` | One structured JSON logger for the actor and facade: Israel-time `ts`, per-request `trace_id`, masked caller ids. |
| `telnyx.toml` | Umbrella manifest — `[[actors]] CALLER_SESSION → CallerSession`, `[[actors]] METRICS → MetricsCounter`, `[telnyx] TELNYX` (Telnyx SDK client used by `alarm()`), `[storage.cloudstorage.ITINERARIES]` (itinerary bucket), a `[[secrets]]` binding for `INTERNAL_API_TOKEN`, the itinerary/reminder `[env_vars]`, and the `[edge_compute] func_id`. |
| `package.json`, `tsconfig.json` | NPM + TypeScript config. `npm test`, `npm run check` (itinerary self-check) and `npm run typecheck`. |

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
| --- | --- | --- |
| `/actors/{callerId}/recordCall` | *(ignored)* | `{callCount, savedCount, lastSaved}` — full profile |
| `/actors/{callerId}/getProfile` | *(ignored)* | `{callCount, savedCount, lastSaved}` |
| `/actors/{callerId}/setLastResults` | `{deals: Deal[], query?, conversationId?}` | `{stored: number}`  — replaces last search results; appends a `search` history entry + audit |
| `/actors/{callerId}/saveDeal` | `{dealId: string, config?: SaveDealConfig, conversationId?}` | `{callCount, savedCount, lastSaved, itineraryUrl?}` — also appends a `save` history entry + audit |
| `/actors/{callerId}/getSaved` | *(ignored)* | `{savedCount: number, deals: Deal[]}` |
| `/actors/{callerId}/getHistory` | *(ignored)* | `{history: HistoryEntry[]}` — the caller's bounded search/save timeline |
| `GET /itineraries/<uuid>.html` | *(none)* | **no bearer** — random UUID is the capability; the HTML page from Cloud Storage (404 on bad id / missing object) |

`recordCall` returns the **full profile** (callCount, savedCount, lastSaved) on
purpose — the webhook builds `call_count`, `saved_count` and `last_saved_deal`
("welcome back, you saved …") from that one response.

## Itinerary page + follow-up SMS reminder (step 7)

`saveDeal` does two extra things after the deal is in `savedDeals`:

  1. **Itinerary HTML in Cloud Storage.** Renders a small, mobile-friendly
     page (city, country, dates, airline, direct or stops, price + currency,
     booking link — every field HTML-escaped) and `put`s it into the
     `ITINERARIES` Cloud Storage bucket under `itineraries/<uuid>.html` with
     `httpMetadata.contentType = "text/html; charset=utf-8"`. A `<dealId → key>`
     map is kept in actor storage so re-saving the same deal reuses its file.

     The public URL `${ITINERARY_BASE_URL}/itineraries/<uuid>.html` is added to
     the returned profile as `itineraryUrl` and surfaced by the MCP
     `save_deal` / `send_deal_sms` tools (the model can read it on the call
     and the SMS text appends `Itinerary: <url>`).

  2. **Follow-up SMS via the actor's single alarm.** Stores
     `{dealId, itineraryUrl}` as the pending reminder and arms the alarm with
     `Date.now() + REMINDER_DELAY_SECONDS*1000`. When it fires, the actor's
     `alarm()` override re-reads the reminder (returning if none), sends one
     SMS to `+<actor id digits>` through `env.TELNYX.messages.send({from:
     SMS_FROM, to, text, messaging_profile_id: MESSAGING_PROFILE_ID})` —
     *"Still thinking about <city> for <price> <currency>? Your itinerary:
     <url>"* — then deletes the reminder. One alarm per actor: a newer save
     replaces the reminder (the last save wins). Never throws from `alarm()`:
     a throw loses the alarm after 3 redrives, so any failure is logged
     `ERROR` with the stack and the reminder is left for a redrive.

### Never break a save

If any of the prerequisites (`env.ITINERARIES`, `ctx.storage.setAlarm`,
`ITINERARY_BASE_URL`) is missing — the **unit tests pass `{}` as env and a
ctx without `setAlarm`** — `saveDeal` logs a `WARNING`, skips the side-effects
and still returns the profile, just without `itineraryUrl`. The save itself
is never coupled to the Cloud Storage write or the alarm schedule.

### Itinerary + reminder config travels with the call (step 11)

**Live finding (7 Oct 08:52 UTC):** the umbrella `telnyx.toml` `[env_vars]`
for this service do **NOT** reach actor instances' `process.env`
(`alarm`-time logs showed `itinerary_skipped reason=noITINERARY_BASE_URL`),
while the MCP server's `func.toml` `[env_vars]` do. The Cloud Storage bucket
binding (`[storage.cloudstorage.ITINERARIES]`) does reach the actor.

So the MCP server forwards `ITINERARY_BASE_URL`, `REMINDER_DELAY_SECONDS`,
`SMS_FROM`, `MESSAGING_PROFILE_ID` on every `saveDeal` call inside `config`:

```jsonc
{ "dealId": "tlv-lca-1", "config": { "itineraryBaseUrl": "https://…",
  "reminderDelaySeconds": 600, "smsFrom": "FlyTLV",
  "messagingProfileId": "4001a112-…" } }
```

`saveDeal(input: {dealId, config?})` resolves each value as
`config.X ?? process.env.X` with type validation: `itineraryBaseUrl`,
`smsFrom` and `messagingProfileId` must be non-empty trimmed strings;
`reminderDelaySeconds` a finite positive number. Bad-typed values are
ignored (dropped, not let through), so a broken `config` never breaks the
save or shadows a good `process.env` fallback.

`smsFrom` and `messagingProfileId` (resolved from either source) are
captured onto the pending reminder in actor storage, so `alarm()` reads
them back from storage rather than `process.env` — the alarm turn sees the
same blind `process.env` the save turn did. `REMINDER_DELAY_SECONDS` is
used only at scheduling time (not stored), since it has no role at fire
time. The values in this service's `telnyx.toml [env_vars]` stay — they are
the source of truth for unit tests, local dev, and the fallback path once
the platform honours the actor umbrella (see `docs/design/DECISIONS.md`
#28).

### `GET /itineraries/<uuid>.html`

A public route (no bearer — the random UUID in the URL is the capability).
The id is validated with a strict UUID regex (404 otherwise). It streams the
object straight out of `env.ITINERARIES` with its stored content type, so the
bucket is the single source of truth the actor wrote.

## Caller history + audit trail (step 20)

`setLastResults` and `saveDeal` each append one entry to a bounded per-caller
**history timeline** in actor storage (`searchHistory`, capped by
`SEARCH_HISTORY_MAX`, default 50, oldest dropped) and write one **immutable
audit JSON object** to the existing `ITINERARIES` Cloud Storage bucket.

- `setLastResults(input: {deals, query?, conversationId?})` appends
  `{ts, conversationId, type:"search", query, resultCount, topDealIds (max 3)}`
  (the `query` is the `search_deals` args exactly as received).
- `saveDeal(input: {dealId, config?, conversationId?})` appends
  `{ts, conversationId, type:"save", dealId}` on every save (including
  re-saves, so the timeline reflects every save attempt).

`getHistory()` returns `{history: HistoryEntry[]}` over the HTTP facade (same
bearer auth as the other routes). `scripts/ops/history.py` reads it (plus
Telnyx conversations + their insight results) for a read-only report.

**Audit** — one object per event, key `${AUDIT_PREFIX}<YYYY-MM-DD>/<conversationId>/<ts>-<type>.json`
(prefix from `AUDIT_PREFIX`, default `audit/`; date in `LOG_TIMEZONE`).
The object holds the event plus a **masked caller** (`***<last4>`, never the
full number). A failed audit write logs `ERROR` with the stack and **never
fails the tool call**; `alarm()` is untouched.

The umbrella `telnyx.toml [env_vars]` (`AUDIT_PREFIX`, `SEARCH_HISTORY_MAX`)
do not reach actor instances' `process.env` in production (live finding #28),
so they default there (`audit/` / 50) — the bucket binding *does* reach the
actor, so audit writes still happen. See `docs/design/DECISIONS.md` (#33).

### Errors

| Status | When |
| --- | --- |
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
npm test          # tests/test_session_actor.test.mts (existing tests, do not edit)
npm run check     # tests/check_itinerary.mts + tests/check_history.mts (step 7 + step 20)
npm run typecheck
```

The existing test (`tests/test_session_actor.test.mts`) injects an in-memory
fake `ctx.storage` and a fake `env.SECRETS.get → "tok"`. It passes `{}` as the
actor env and a `ctx` without `setAlarm`, which exercises the "never break a
save" path. The itinerary self-check (`tests/check_itinerary.mts`) adds
fakes for `ctx.storage.setAlarm`, a Cloud Storage bucket and `env.TELNYX`,
then exercises the bucket write/rewrite, the alarm SMS-once semantics, and
the public GET route. Both run with the Node built-in test runner via `tsx`.
Only the unit layer uses fakes — every other service talks to a real Telnyx
actor.

## Deploy

```bash
# The shared bearer the Python services also send:
telnyx-edge secrets add INTERNAL_API_TOKEN <value>

# Cloud Storage bucket the actor writes the itinerary HTML into:
telnyx-edge storage create flytlv-itineraries --region us-central-1

cd services/session-actor
telnyx-edge ship
```

`ship` bundles `src/index.ts` (which re-exports `CallerSession`) and uploads
under the umbrella `name = "fde-session-actor"` declared in `telnyx.toml`.
