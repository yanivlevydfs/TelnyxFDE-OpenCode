# FlyTLV Travel Line — integration & operations guide

Audience: engineers integrating with or operating the FlyTLV Travel Line. This
is every integration point with its exact contract, auth and failure
behaviour; the configuration reference; deploy and provisioning; how to
test; and a troubleshooting table. The product view is in
[docs/design/PRODUCT.md](../design/PRODUCT.md); the design rationale is in
[docs/design/ARCHITECTURE.md](../design/ARCHITECTURE.md) and
[docs/design/DECISIONS.md](../design/DECISIONS.md).

## Architecture

```
Caller (phone) → +972 76-567-1113 → TeXML app "FLYTLV ai-assistant"
  → assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16 (model zai-org/GLM-5.3-Flash on Telnyx Inference)
  → Conversation Workflow (12 nodes, 26 edges — assistant/flow.py)

  1) CALL START (once per call)
     assistant.initialization webhook → fde-webhook (Python Edge Function)
       ├─ signature: telnyx.Ed25519 BEFORE JSON parse
       ├─ KV REST:      get flags/assistant            (60 s in-process cache)
       ├─ HTTP  → actor: recordCall                     (under WEBHOOK_BUDGET_MS)
       └─ KV REST:      put session/<conv_id>={entity_id} (AFTER the response; TTL 1 h)
     ← {"dynamic_variables": {caller_known, call_count, saved_count,
                              last_saved_deal, backend_degraded, flag_*}}

  2) MID-CONVERSATION TOOL CALLS (per prompt-node LLM turn)
     prompt node → MCP tools/call → fde-mcp (TypeScript Edge Function)
       ├─ bearer: Authorization: Bearer <MCP_API_KEY>
       ├─ conversation id: params._meta.telnyx_conversation_id
       ├─ KV env.KV:
       │     session/<conv_id> → {entity_id}              (written by the webhook)
       │     cache/deals/<sig> → full flytlv payload       (TTL DEALS_CACHE_TTL)
       ├─ upstream HTTP: GET flytlv.app/api/private/deals  (X-API-Key, fail-closed 404)
       ├─ shared actor (production): env.SESSIONS.idFromName(entityId)[method](body)
       │     setLastResults / saveDeal / getSaved          (no HTTP hop, no bearer)
       ├─ HTTP fallback (USE_SHARED_ACTOR=false or Python webhook):
       │     POST {ACTOR_SERVICE_URL}/actors/{entity}/{method} (Bearer INTERNAL_API_TOKEN)
       └─ HTTP: POST {ACTOR_SERVICE_URL}/metrics/add       (MetricsCounter, fire-and-forget)

  3) SIDE EFFECTS OF A SAVE (CallerSession.saveDeal, on fde-session-actor)
       ├─ Cloud Storage: ITINERARIES.put(itineraries/<uuid>.html, mobile-friendly HTML)
       ├─ actor storage: K_ITINERARY_KEYS (dealId → key, reuse on re-save)
       └─ actor alarm:   ctx.storage.setAlarm(now + REMINDER_DELAY_SECONDS*1000)
                         alarm() → env.TELNYX.messages.send(SMS to +<digits>)
                                     then delete the pending reminder

  4) PUBLIC READ
     GET https://fde-session-actor-94b99eb9-4.telnyxcompute.com/itineraries/<uuid>.html
       (no bearer; the random UUID is the capability; strict UUID regex, 404 otherwise)
```

### Request path of a call (trace id where it flows)

The webhook sets `trace_id` to `telnyx_conversation_id` (fallback
`call_control_id`); the MCP server receives the same id in
`params._meta.telnyx_conversation_id`. Only the HTTP path forwards it to the
actor over `TRACE_HEADER` (default `x-trace-id`): the webhook's `ActorClient`
sends it, and the MCP server's `ActorClient` fallback sends it. The MCP
server's production `EdgeActor` (the `SESSIONS` RPC binding) sends no trace
header, and `ActorMetrics` sends none — so in production the conversation id
does NOT reach the session-actor's log from the MCP server. One id threads
the webhook and MCP logs; the actor log carries it only when it was reached
over the HTTP facade (e.g. every webhook-driven `recordCall`):

```bash
for fn in fde-webhook fde-mcp fde-session-actor; do
  telnyx-edge logs $fn --type runtime --json --since 1h
done | jq -c 'select(.trace_id=="<conversation-id>")'
```

## Integration points

### 1. Telnyx Dynamic Variables webhook — `fde-webhook` (Python Edge Function)

| | |
| --- | --- |
| URL | `https://fde-webhook-e5907143-e.telnyxcompute.com` (registered `fde-webhook`, `func_id e5907143-e572-4e86-8880-0de76f057561`) |
| Method | `POST /` |
| Auth | **Telnyx Ed25519 webhook signature**. `client.webhooks.unwrap(body, headers=...)` is run on the raw body BEFORE JSON parse; `ValueError` subclass on a bad/stale signature → `401`. Skipped only when `WEBHOOK_VERIFY_SIGNATURE=false` (local curl testing). |
| Time budget | `WEBHOOK_BUDGET_MS` (default 2500) — below the assistant's `dynamic_variables_webhook_timeout_ms` (8000, Telnyx guidance for Edge cold starts). |
| Body | Telnyx `assistant.initialization` event. Read fields: `data.payload.telnyx_end_user_target` (caller phone) and `data.payload.telnyx_conversation_id`. |
| Side calls (in parallel) | KV REST `get flags/assistant`; HTTP `POST {ACTOR_SERVICE_URL}/actors/{entity}/recordCall` (Bearer `INTERNAL_API_TOKEN`). The flags read is cached in-process for `FLAGS_CACHE_SECS` (default 60). |
| After the response | KV REST `put session/<conv_id> = {entity_id}` with TTL `SESSION_TTL` (default 3600); one batched metrics `POST {ACTOR_SERVICE_URL}/metrics/add`. Neither eats into the time budget. |
| Reply | `{"dynamic_variables": {...}}` — flat **string** values only. |
| Variables returned | `caller_known` (`true` if `callCount > 1`), `call_count`, `saved_count`, `last_saved_deal` (`""` or `"<city>, <price> <currency>"`), `backend_degraded` (`"true"` if the actor timed out/failed), and `flag_<name>` for every scalar flag in `flags/assistant` (e.g. `flag_deals_enabled`, `flag_sms_enabled`, `flag_promo`). |
| Degraded defaults | Only the actor (`recordCall`) failing or timing out sets `backend_degraded="true"` with the safe defaults. A failed flags read only falls back to default flags (it does NOT mark degraded). The session KV write (`session/<conv_id>`) runs AFTER the response — a failure logs `webhook.session_write_failed` ERROR but does NOT degrade (the MCP tools then report an unknown call). |
| Caller-id rule | Only an E.164 phone (`+` prefix, 8–15 digits after stripping) is treated as a caller identity and an SMS destination. A national number, SIP URI or anonymous caller → `entity=""`: deals can still be read but nothing is saved or texted. |
| Errors | `401 {error:"invalid signature"}` (bad signature), `400 {error:"invalid json"}` (unparseable body). Network/dependency failures are absorbed (degraded response). |

Worked example (objective): a returning caller who has saved Larnaca for 64
USD gets `{"caller_known":"true","call_count":"2","saved_count":"1",
"last_saved_deal":"Larnaca, 64 USD","backend_degraded":"false",
"flag_deals_enabled":"true","flag_sms_enabled":"true"}`.

### 2. MCP server — `fde-mcp` (TypeScript Edge Function)

| | |
| --- | --- |
| URL | `https://fde-mcp-bc3393fa-a.telnyxcompute.com` (registered `fde-mcp`, `func_id bc3393fa-a5f2-4470-b7af-137f3d9c831d`) |
| Method | `POST /` (one JSON-RPC message per call; stateless Streamable HTTP, JSON response) |
| Health | `GET /health` and any path under `/health/` → `200 {status:"ok"}` (no auth) — used by the platform liveness/readiness probes. |
| Auth | `Authorization: Bearer <MCP_API_KEY>`. Checked BEFORE the MCP transport sees the request; constant-time compare. Mismatch → `401 {error:"unauthorized"}`. The token is registered with Telnyx as an integration secret (`api_key_ref`, identifier `flytlv-mcp-key` by default) so Telnyx sends it on every tool call. |
| Conversation id | `params._meta.telnyx_conversation_id` from the JSON-RPC request. Becomes the `trace_id` for all logs and outbound calls; the caller is resolved from `session/<conv_id>` in KV. |
| Server construction | A fresh `McpServer` + stateless `StreamableHTTPServerTransport` per request (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). The actor is `EdgeActor` (`USE_SHARED_ACTOR=true`, default) or `ActorClient` (HTTP facade, `USE_SHARED_ACTOR=false`). |
| Tool failure surface | `{"content":[{"type":"text","text":<caller-friendly msg>}],"isError":true}` — never a traceback, URL or API key. |

#### Tools (input schema and outputs)

All tools resolve the caller with `requireCaller(kv, conv)` (or
`readCaller` for `search_deals`, where a hidden id is allowed). Names and
schemas come from `services/mcp-server/src/server.ts` (zod).

**`search_deals`** — query the live `flytlv.app` deals API (KV-cached) and
remember the deals on the caller's actor (`setLastResults`).

| Argument | Type | Notes |
| --- | --- | --- |
| `trip_type` | `enum ["round_trip","one_way"]` | optional; default `round_trip` |
| `destination` | `string` (IATA `^[A-Za-z]{3}$`) | optional |
| `country` | `string` 2–60 | optional; English name or ISO code |
| `category` | `string` 2–40 | optional; flytlv holiday/trip-style |
| `weekend` | `enum ["upcoming","following"]` | optional; Thu/Fri/Sat computed on the server |
| `departure_date` | `string` (`YYYY-MM-DD` or comma-separated list) | optional |
| `departure_weekday` | `enum Sunday..Saturday` | optional |
| `min_nights` / `max_nights` | `int 1..60` | optional (round trips) |
| `max_price` | `number > 0` | optional |
| `min_discount_pct` | `int 1..99` | optional (round trips) |
| `direct_only` | `boolean` | optional |
| `max_layover_hours` | `number ≤ 48` | optional (round trips) |
| `time_of_day` | `array of enum morning/afternoon/evening/night` (1–4) | optional (round trips) |
| `sort` | `enum cheapest/best_value/biggest_discount/soonest/fastest` | optional; default cheapest |

Output: `{deals: Deal[]}` (Deal shape below). Flights leaving within
`MIN_HOURS_BEFORE_DEPARTURE` (default 3, Israel time) are dropped; rows with
no `deal_id` are dropped (the actor would reject them on save).

**`save_deal`** — save one of the last-shown deals (actor validates the
choice). Input: `{deal_id: string 1..100}`. The MCP server forwards
itinerary/reminder `config` on the actor call (see §5). Output:
`{saved:true, dealId, itineraryUrl?}` — `itineraryUrl` is set only when the
actor wrote the Cloud Storage page and armed the alarm.

**`list_saved_deals`** — read the deals saved on previous calls. No input.
Output: the actor's `getSaved` result: `{savedCount, deals: Deal[]}`.

**`send_deal_sms`** — text the caller a shown deal and its booking link
(registered only when an SMS sender is wired). Input `{deal_id: string
1..100}`. Checks the KV flag `sms_enabled` (default on); calls `saveDeal`
then `getSaved`, finds the deal, and texts it to `+<entity_id>`. The SMS body
is `FlyTLV: <city>, <country> - <price> <currency> round trip|one way[, direct]. [Save <savings> <currency> (<discountPct>% off).]` / `Out <date> <time> <flightNumber>. Back <date> <time> <flightNumber>.` / `Book: <url>`, with `Itinerary: <url>` appended when the actor returned one. Output: `{sent:true, dealId}`.

`Deal` shape (camelCase, mirrors the Python `slim()`):
`dealId, city, country, price, currency, departureDate, returnDate, airline,
direct, url, tripType?, category?, departureWeekday?, returnWeekday?,
discountPct?, savingsAmount?, typicalPrice?, dealQuality?, fromAirport?,
toAirport?, nights?, outbound?: Leg, inbound?: Leg`. `Leg`:
`departs, arrives, airline, flightNumber, stops, durationMin, via?: string[],
layoverMin, route`.

Tool errors map to caller-safe messages: the actor's `ActorInputError`
(e.g. "deal tlv-lca-1 not found in last search results") is passed through; an
unreachable actor becomes "The session service is unavailable" (logged with
the stack, never shown to the model).

### 3. Session actor — `fde-session-actor` (TypeScript, umbrella `telnyx.toml`)

URL: `https://fde-session-actor-94b99eb9-4.telnyxcompute.com` (`func_id
94b99eb9-4c3e-4790-8e2a-8db700bea1a5`). Two Stateful Actors are declared:
`CallerSession` (binding `CALLER_SESSION`, one instance per caller) and
`MetricsCounter` (binding `METRICS`, one `global` instance). The `TELNYX`
binding is a pre-authenticated SDK client used by `alarm()`.

#### 3a. Shared actor binding (production path for the MCP server)

```
[[actors]] binding = "SESSIONS"  type = "CallerSession"   # in fde-mcp/func.toml
```

This is Telnyx "shared actors": `fde-session-actor` owns the `CallerSession`
class; `fde-mcp` declares the same `type` under its `SESSIONS` binding and
**ships no class code** — the Edge runtime forwards the call over an RPC hop
to the owning function. The MCP server's `EdgeActor` calls
`env.SESSIONS.idFromName(entityId)[method](body)` directly — no HTTP hop, no
bearer (the binding is the trust boundary). Over the RPC hop an
`ActorInputError` arrives as a plain `Error` whose message embeds
`{"name":"ActorInputError","message":"..."}`; `EdgeActor` (and the facade)
recover that marker and map it to a 4xx-class error; anything else is a
transient `ActorError`.

#### 3b. HTTP facade — `POST /actors/{digits}/{method}` (bearer `INTERNAL_API_TOKEN`)

Used by the Python webhook (which cannot bind actors) and selectable from
the MCP server with `USE_SHARED_ACTOR=false` (local debugging). Same bearer
token, lower-cased here for brevity:

| Route | Body | Returns | Errors |
| --- | --- | --- | --- |
| `POST /actors/{caller}/recordCall` | *(ignored)* | `{callCount, savedCount, lastSaved}` | `400` non-digit id / method not allowed / `ActorInputError` |
| `POST /actors/{caller}/getProfile` | *(ignored)* | `{callCount, savedCount, lastSaved}` | same |
| `POST /actors/{caller}/setLastResults` | `{deals: Deal[]}` | `{stored: number}` | `400` non-array / element not a `Deal` |
| `POST /actors/{caller}/saveDeal` | `{dealId: string, config?: SaveDealConfig}` | `{callCount, savedCount, lastSaved, itineraryUrl?}` | `400` missing `dealId` / `dealId` not in last results / bad `config` type (silently dropped, not raised) |
| `POST /actors/{caller}/getSaved` | *(ignored)* | `{savedCount, deals: Deal[]}` | same |

Routing precedes auth: a non-POST request returns `405`, and a path that is
neither `POST /actors/{entity}/{method}` nor `POST /metrics/{op}` returns
`404` (auth is never reached for them). After that, auth precedes
entity/method validation — a valid-looking but unauthenticated route returns
`401` and learns nothing about entity/method. Caller id must be digits only
(`entity_id` strips to digits; actor names cannot contain `+`). The method
must be in the static allowlist `{recordCall, getProfile, setLastResults,
saveDeal, getSaved}`. A missing/empty body defaults to `{}`; a malformed
(unparseable) body → `400`. Any other failure is logged `ERROR dispatch_failed`
with the stack and returned `500`.

`recordCall` returns the **full profile** on purpose — the webhook builds
`call_count`, `saved_count` and `last_saved_deal` from that one response.

#### 3c. Metrics facade — `POST /metrics/{add|snapshot|reset}`

| Route | Body | Returns |
| --- | --- | --- |
| `POST /metrics/add` | `{counts: {name:number}, latency: {name:ms}}` | `{ok:true}` |
| `POST /metrics/snapshot` | *(none)* | `{since, counts, latency:{name:{count,avg_ms,max_ms}}}` |
| `POST /metrics/reset` | *(none)* | `{ok:true}` |

Same bearer `INTERNAL_API_TOKEN`. Metric names match `/^[a-z0-9_.]{1,64}$/`;
non-finite/negative values are rejected with `ActorInputError` → `400`. The
MCP server sends one batched `add` per request (fire-and-forget); the webhook
sends one after the response.

#### 3d. Public itinerary route — `GET /itineraries/<uuid>.html`

**No bearer.** The random UUID in the URL is the capability (Telnyx Edge Cloud
Storage exposes no signed URLs). Strict regex
`^/itineraries/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.html$`
(case-insensitive) — anything else is `404`. A missing binding or missing
object is `404` (so the route stays up while the bucket is being
provisioned); a read failure is logged `ERROR itinerary.read_failed` and
returned `500`. Streams the object body with its stored content type.

### 4. flytlv.app deals API

| | |
| --- | --- |
| URL | `GET {FLYTLV_API_BASE}{FLYTLV_DEALS_PATH}` — default `https://flytlv.app/api/private/deals` (round trips); one-way flights at `/api/private/flights` (`FLYTLV_FLIGHTS_PATH`). |
| Auth | `X-API-Key: <FLYTLV_API_KEY>` header on **every** request (header name overridable via `FLYTLV_API_KEY_HEADER`). The `FLYTLV_API_KEY` Edge secret is **required** — `FlytlvClient` is built per request in `createServer`, so a missing/rejected key makes every request fail (`mcp.request_failed` ERROR, HTTP 500) before the feed is called; the server still boots (only `MCP_API_KEY` is checked at boot, in `createHandler`). |
| Query params (forwarded) | `sort` (cheapest / best / date_asc / fastest), `one_per_destination=true`, `limit`, `destination` (IATA, upper-cased), `stops=0` (direct only), `max_price`, `departure_date` (round trips) or `date` (one way), `min_discount_pct`, `max_layover` (minutes), `time_windows` (comma-separated). |
| Response fields | `{currency, deals: [{deal_id, price, departure_date, return_date, airline, is_direct, deal_url, nights, origin{iata,airport_name}, destination_airport{city, country, country_code, iata, airport_name}, outbound_*, inbound_*, deal_category_label, deal_category_label_he, deal_quality, discount_pct, savings_amount, typical_price, trip_type, departure_weekday, return_weekday}]}`. Many fields are optional on the feed. |
| Fail-closed 404 | A wrong/missing key (or a switched-off feed) returns `404`. The client logs this once per instance as `flytlv.feed_off` ERROR and surfaces "The deals service is unavailable right now" to the caller. Not retried (it is a config state, not a transient error). |
| Other failures | `429` → "deals service is busy", `≥400` → "deals service is unavailable", timeout → "taking too long to respond", bad JSON → "unreadable response", unexpected shape → "unexpected response". All caller-friendly; never leak the URL, key or a traceback. |
| Timeout | `FLYTLV_TIMEOUT_MS` (default 3000), retried once on a timeout only (a cold connection after a deploy can stall — seen live: 3 s then 0.4 s). |

### 5. Telnyx KV keys, Cloud Storage, Messaging, alarm reminder

**KV** (`fde-kv` namespace, `KV_NAMESPACE_ID`). The Python webhook reaches KV
through the SDK REST API; the TypeScript MCP server uses the `env.KV` binding:

| Key | Shape | Writer | Reader | TTL |
| --- | --- | --- | --- | --- |
| `flags/assistant` | `{deals_enabled?: bool, sms_enabled?: bool, promo?: string, ...}` | operator | webhook (60 s in-process cache); MCP `sms_enabled` check | — |
| `session/<conversation_id>` | `{entity_id: string}` | webhook (after the response) | MCP tools (`readCaller` / `requireCaller`) | `SESSION_TTL` (default 3600) |
| `cache/deals/<sig>` | the full flytlv payload | MCP `search_deals` (after a flytlv hit) | MCP `search_deals` (cache hit re-slims without another upstream call) | `DEALS_CACHE_TTL` (default 300) |

KV cache keys are KV-legal only (`a-zA-Z0-9-_/=.`; a `|` or `,` is a 400 —
seen live) — `cacheKey()` joins params with `/` and replaces anything else
with `_`.

**Cloud Storage** — bucket `flytlv-itineraries`, region `us-central-1`,
declared `[storage.cloudstorage.ITINERARIES]` in `services/session-actor/telnyx.toml`.
`CallerSession.saveDeal` writes `itineraries/<crypto.randomUUID()>.html` with
`httpMetadata.contentType = "text/html; charset=utf-8"`; a `map<dealId, key>`
in actor storage makes a re-save reuse the same file. Every value is
HTML-escaped. The Edge runtime has no signed Cloud Storage URLs, so the
public read route (§3d) is the only way to fetch a page.

**Messaging** — the alphanumeric sender `FlyTLV` on the messaging profile
`flytlv-sms` (`MESSAGING_PROFILE_ID`, `4001a112-28fd-40f5-a0de-226b1bad6b80`),
Israel only, $5/day cap per messaging profile (Telnyx Israeli numbers are
voice-only, so an alphanumeric sender is required). `send_deal_sms` sends
via the MCP server's `env.TELNYX.messages.send`; the follow-up reminder
sends via the actor's `env.TELNYX.messages.send` from `alarm()`. Today the
account level allows only long-code senders, so the "FlyTLV" sender is
rejected — `send_deal_sms` surfaces "I couldn't send the text message right
now; the deal is saved." and the reminder's `alarm()` catches the throw as
`ERROR alarm.failed` and keeps the reminder for a redrive. The reminder is
only drained to `WARNING alarm.sms_config_missing` when the `env.TELNYX`
binding, `smsFrom` or `messagingProfileId` is missing — a config gap, not a
rejected sender (see `OBSERVABILITY.md`).

**Actor alarm reminder.** `saveDeal` writes a pending reminder
`{dealId, itineraryUrl, smsFrom?, messagingProfileId?}` to actor storage and
arms `ctx.storage.setAlarm(now + REMINDER_DELAY_SECONDS*1000)` (one alarm
per actor: a newer save replaces the reminder — the last save wins). When it
fires, `alarm()` re-reads the reminder (returns if none — at-least-once),
looks up the deal, sends one SMS to `+<actor id digits>` from `smsFrom` /
`messagingProfileId` (read from the reminder first, falling back to
`process.env.SMS_FROM` / `process.env.MESSAGING_PROFILE_ID` when the
reminder carries none), then deletes the reminder. `alarm()` never
throws (a throw loses the alarm after 3 redrives): every failure is caught
and logged `ERROR alarm.failed` with the stack; the reminder stays in place
for a redrive unless the SMS actually sent.

## Configuration reference

Every value is an env var or an Edge secret — except the MCP server's
`[storage.kv.KV]` id, which is a literal in `func.toml` (the `fde-kv`
namespace id). Below is the per-service reference, read from `func.toml` /
`telnyx.toml` / the code.

> **Live finding (7 Oct 08:52 UTC, after the step 7-8 deploy):** the umbrella
> `telnyx.toml` `[env_vars]` for `fde-session-actor` **do NOT** reach actor
> instances' `process.env` (logs showed `itinerary_skipped
> reason=noITINERARY_BASE_URL`). The bound `[storage.cloudstorage.ITINERARIES]`
> bucket DOES reach the actor, and a function's own `func.toml` `[env_vars]`
> DO. Work-around: the MCP server reads the itinerary/reminder values from
> its own `func.toml` and forwards them on every `saveDeal` call in `config`;
> the actor resolves `config.X ?? process.env.X` (validated; bad ones
> dropped) and captures `smsFrom` / `messagingProfileId` on the pending
> reminder so `alarm()` reads them from storage (decision #28, #29).

### Edge secrets (org-scoped; `telnyx-edge secrets add <NAME> <VALUE>`)

| Secret | Used by | Purpose |
| --- | --- | --- |
| `TELNYX_API_KEY` | webhook, mcp-server, session-actor, assistant | auto-injected by the `[telnyx]` binding; also used by `provision.py` |
| `TELNYX_PUBLIC_KEY` | webhook | Ed25519 key for webhook signature verification |
| `KV_NAMESPACE_ID` | webhook (REST only) | the `fde-kv` KV namespace id; the MCP server's `[storage.kv.KV]` binding uses a literal id in `func.toml`, not this secret |
| `ACTOR_SERVICE_URL` | webhook, mcp-server | `https://fde-session-actor-<id>.telnyxcompute.com`. **Always required by `fde-mcp`**: per-request metrics `POST /metrics/add` goes over HTTP even with `USE_SHARED_ACTOR=true`, and `ActorClient` (the fallback path) needs it. |
| `INTERNAL_API_TOKEN` | webhook, mcp-server (fallback), session-actor | shared bearer: the webhook + MCP `ActorClient` send it; the actor facade reads it through `env.SECRETS.get` |
| `MCP_API_KEY` | mcp-server, assistant | bearer the assistant sends to the MCP server; stored as the integration secret `api_key_ref` |
| `FLYTLV_API_KEY` | mcp-server | flytlv private deals feed (`X-API-Key` header) |

### `fde-webhook` (`services/webhook/func.toml`)

| Var | Default | Read where |
| --- | --- | --- |
| `WEBHOOK_VERIFY_SIGNATURE` | `true` | read in `new()` (`c.flag`, passed as the `verify` arg); `_handle` skips the Ed25519 check when `false` |
| `WEBHOOK_BUDGET_MS` | `2500` | `_fetch_context` parallel fan-out budget |
| `HTTP_TIMEOUT_MS` | `1000` | the `httpx.AsyncClient` to the actor |
| `KV_FLAGS_KEY` | `flags/assistant` | the flags KV key |
| `SESSION_KEY_PREFIX` | `session/` | KV key prefix for the conversation→caller map |
| `SESSION_TTL` | `3600` | TTL on the session map key |
| `FLAGS_CACHE_SECS` | `60` | in-process flags cache TTL — code default (not in `func.toml` `[env_vars]`) |
| `TRACE_HEADER` | `x-trace-id` | outbound trace header to the actor — code default (not in `func.toml` `[env_vars]`) |
| `LOG_LEVEL`, `LOG_TIMEZONE` | `INFO`, `Asia/Jerusalem` | structured JSON logging — code default (not in `func.toml` `[env_vars]`) |

### `fde-mcp` (`services/mcp-server/func.toml`)

Bindings: `[telnyx] TELNYX`, `[storage.kv.KV] id=445c3e11-c172-48df-af37-3486ca3ff50c`,
`[[actors]] SESSIONS → CallerSession`.

| Var | Default | Read where |
| --- | --- | --- |
| `MCP_SERVER_NAME` | `fde-mcp` | the MCP server name |
| `USE_SHARED_ACTOR` | `true` | `index.ts` chooses `EdgeActor` vs `ActorClient` |
| `FLYTLV_API_BASE` | `https://flytlv.app` | the feed base URL |
| `FLYTLV_DEALS_PATH` | `/api/private/deals` | the round-trips endpoint |
| `FLYTLV_FLIGHTS_PATH` | `/api/private/flights` | the one-way endpoint — code default (not in `func.toml` `[env_vars]`) |
| `FLYTLV_API_KEY_HEADER` | `X-API-Key` | the auth header name |
| `FLYTLV_TIMEOUT_MS` | `3000` | feed timeout (retried once on timeout) |
| `DEALS_FETCH_LIMIT` / `DEALS_COUNTRY_FETCH_LIMIT` / `DEALS_BROAD_FETCH_LIMIT` | `20` / `300` / `300` | rows pulled per query (a broad filter fetches more). `DEALS_FETCH_LIMIT` is in `func.toml`; `DEALS_COUNTRY_FETCH_LIMIT` / `DEALS_BROAD_FETCH_LIMIT` are code defaults (not in `func.toml` `[env_vars]`) |
| `DEALS_RESULT_LIMIT` | `5` | rows spoken / remembered per call |
| `DEALS_CACHE_TTL` | `300` | KV cache TTL for a flytlv payload |
| `DEALS_CACHE_PREFIX` | `cache/deals/` | KV key prefix |
| `SESSION_KEY_PREFIX` | `session/` | KV key prefix for the session map read |
| `KV_FLAGS_KEY` | `flags/assistant` | the flags key for `sms_enabled` — code default (not in `func.toml` `[env_vars]`) |
| `HTTP_TIMEOUT_MS` | `3000` | `ActorClient` HTTP timeout |
| `CALLER_TIMEZONE` | `Asia/Jerusalem` | weekend dates + the departure cutoff — code default (not in `func.toml` `[env_vars]`) |
| `MIN_HOURS_BEFORE_DEPARTURE` | `3` | hide flights leaving sooner — code default (not in `func.toml` `[env_vars]`) |
| `TRACE_HEADER` | `x-trace-id` | outbound trace header to the actor |
| `LOG_LEVEL` | `INFO` | structured JSON logging |
| `SMS_FROM` | `FlyTLV` | alphanumeric sender — forwarded in `saveDeal` `config` |
| `MESSAGING_PROFILE_ID` | `4001a112-28fd-40f5-a0de-226b1bad6b80` | messaging profile — forwarded in `config` |
| `ITINERARY_BASE_URL` | `https://fde-session-actor-94b99eb9-4.telnyxcompute.com` | public prefix for itinerary pages — forwarded in `config` |
| `REMINDER_DELAY_SECONDS` | `600` | reminder delay (seconds) — forwarded in `config` as a number |

### `fde-session-actor` (`services/session-actor/telnyx.toml`)

Bindings: `[[actors]] CALLER_SESSION → CallerSession`, `[[actors]] METRICS → MetricsCounter`,
`[telnyx] TELNYX`, `[storage.cloudstorage.ITINERARIES] bucket_name=flytlv-itineraries region=us-central-1`,
`[[secrets]] INTERNAL_API_TOKEN` (read via `env.SECRETS.get`).

| Var | Default | Read where |
| --- | --- | --- |
| `INTERNAL_API_TOKEN` | (secret) | bearer on the HTTP facade (`env.SECRETS.get`) |
| `MAX_SAVED_DEALS` | `50` | `saveDeal` bounds `savedDeals` — code default (not in `telnyx.toml` `[env_vars]`) |
| `LOG_LEVEL`, `LOG_TIMEZONE` | `INFO`, `Asia/Jerusalem` | structured JSON logging — code default (not in `telnyx.toml` `[env_vars]`) |
| `TRACE_HEADER` | `x-trace-id` | inbound trace header for the log span — code default (not in `telnyx.toml` `[env_vars]`) |
| `ITINERARY_BASE_URL` | `https://fde-session-actor-94b99eb9-4.telnyxcompute.com` | **actor reads this from the `saveDeal` `config` first**; `process.env` is the fallback |
| `REMINDER_DELAY_SECONDS` | `600` | same — `config` first, `process.env` fallback |
| `SMS_FROM` | `FlyTLV` | same — `config` first, `process.env` fallback |
| `MESSAGING_PROFILE_ID` | `4001a112-28fd-40f5-a0de-226b1bad6b80` | same — `config` first, `process.env` fallback |

### `assistant/provision.py` (and the assistant body)

Env vars (see `.env.example`): `TELNYX_API_KEY`, `ASSISTANT_MODEL`
(`zai-org/GLM-5.3-Flash` — must be `recommended_for_assistants` in
`/v2/ai/models`), `ASSISTANT_VOICE` (`Telnyx.KokoroTTS.af_heart`),
`WEBHOOK_URL`, `MCP_URL`, `MCP_API_KEY`; optional `ASSISTANT_NAME`,
`ASSISTANT_DESCRIPTION`, `ASSISTANT_PHONE_NUMBER` (transfer `from`),
`TRANSFER_TO_NUMBER` (transfer `to`; empty ⇒ no transfer tool),
`TRANSFER_TO_NAME` (e.g. Ofek), `HANGUP_TOOL_ID` (shared hangup tool id),
`ASSISTANT_ID` (update instead of create), `MCP_SERVER_ID` (reuse instead of
register), `ASSISTANT_PHONE_NUMBER_ID` (link target),
`ASSISTANT_CONNECTION_ID` (optional voice connection),
`MCP_API_KEY_REF` (identifier for the integration secret; default
`flytlv-mcp-key`), `MCP_SERVER_NAME`, `WEBHOOK_TIMEOUT_MS` (8000),
`CONVERSATION_TIMEOUT_SECS` (600 — the duration comparison for the
escalation edge).

## Deploy

Deploys run from Linux in GitHub Actions
([.github/workflows/ship.yml](../../.github/workflows/ship.yml)) — the
Windows `telnyx-edge` (v0.5.9) zips paths with backslashes, so Linux builders
see flat files instead of folders (proven by shipping the unmodified
official scaffold and watching it fail the same way).

- **Automatic:** a push to `master` that changes `services/` or `shared/`
  ships all three services (one ship per service at a time; a second gets
  `409 Function Busy`).
- **Manual:** Actions → *Ship Edge Functions* → *Run workflow* with
  `service` = `all`, `webhook`, `mcp-server` or `session-actor`.

The workflow runs `python scripts/build/vendor_shared.py` (copies
`shared/common.py` into each Python service), installs `telnyx-edge v0.5.9`,
sets the CLI auth from the repo secret `TELNYX_API_KEY`, and runs
`telnyx-edge ship --from-dir services/<service> --timeout 20m`.

By hand on Linux/macOS:

```bash
python scripts/build/vendor_shared.py
telnyx-edge ship --from-dir services/webhook
telnyx-edge ship --from-dir services/mcp-server
telnyx-edge ship --from-dir services/session-actor   # umbrella telnyx.toml; npm ci first
```

### Provision the assistant (`assistant/provision.py`)

After the three Edge services are live, provision the assistant end-to-end
through the official `telnyx` Python SDK in four ordered, JSON-logged steps:

1. **Integration secret** — stores `MCP_API_KEY` at `/v2/integration_secrets`.
2. **MCP server** — `/ai/mcp_servers` pointing at the deployed `fde-mcp` Edge
   Function, authenticated via the secret as `api_key_ref`.
3. **Assistant** — `/v2/ai/assistants` with the conversation workflow, the
   dynamic-variables webhook URL + `dynamic_variables_webhook_timeout_ms`
   (8000), the MCP server reference, the inline `hangup`/`transfer` tools
   built by `assistant/flow.py`, and the terminal hangup **tool node**
   (`HANGUP_TOOL_ID`, created on first run).
4. **Phone number** — links the owned number to the assistant's voice
   connection (soft step: if Telnyx exposes no connection id the number is
   left for a one-click link in the Portal).

Re-running is safe: an existing integration secret is reused, `MCP_SERVER_ID`
reuses the registered MCP server, `ASSISTANT_ID` updates the existing
assistant.

```bash
python assistant/provision.py --dry-run     # print the assistant body, no API calls (still needs ASSISTANT_MODEL, ASSISTANT_VOICE and WEBHOOK_URL set — the _req vars in assistant_body)
TELNYX_API_KEY=... ASSISTANT_MODEL=zai-org/GLM-5.3-Flash ASSISTANT_VOICE=Telnyx.KokoroTTS.af_heart \
WEBHOOK_URL=https://fde-webhook-<id>.telnyxcompute.com \
MCP_URL=https://fde-mcp-<id>.telnyxcompute.com MCP_API_KEY=... \
ASSISTANT_PHONE_NUMBER_ID=... TRANSFER_TO_NUMBER=... \
python assistant/provision.py
```

Deploy order is fixed (the assistant references live webhook + MCP URLs):
**secrets → KV → `ship` webhook · mcp-server · session-actor → `provision.py`**.

## How to test

### Unit and self-checks

```bash
python scripts/build/vendor_shared.py                                     # vendor shared/common.py first
.venv/Scripts/python -m pytest tests -q                                   # 29 Python tests
cd services/session-actor && npm test && npm run check && npm run typecheck   # actor 7/7 + itinerary check 8/8
cd services/mcp-server && npm test && npm run typecheck                       # MCP 11/11
.venv/Scripts/python -m pytest tests/check_flow_capabilities.py -q            # step 9 capability self-check
```

| File | Covers |
| --- | --- |
| `tests/test_common.py` | `shared/common.py`: config, JSON logging, KV wrapper, actor client, phone helpers |
| `tests/test_webhook.py` | Dynamic Variables webhook: signature, variables, degraded defaults, time budget |
| `tests/test_assistant.py` | Workflow graph, expression-edge variables and defaults, tools, provisioning body |
| `tests/test_mcp.test.mts` | MCP server: auth, tools, cache, actor errors, `slim()` |
| `tests/test_session_actor.test.mts` | CallerSession actor and the HTTP facade |
| `tests/check_search_filters.mts` | Weekend dates, country filter, departure cutoff, SMS text |
| `tests/check_metrics.mts` | MetricsCounter actor and the facade `/metrics` routes |
| `tests/check_webhook_metrics.py` | The webhook reports metrics after responding |
| `tests/check_itinerary.mts` | Cloud Storage write + reuse, alarm SMS-once, public `GET /itineraries`, "config travels with the call" path |
| `tests/check_flow_capabilities.py` | Every step 9 capability is covered in `flow.py`, mapped only to real `search_deals` args |

### Live checks (against the deployed Telnyx Edge)

```bash
python scripts/ops/live_check.py            # end-to-end: 20/20 PASS (security, tools, search, save, hidden id, SMS kill switch, actor concurrency, metrics)
python scripts/ops/metrics.py [--reset]     # MetricsCounter snapshot: counts, degraded rate, cache hit rate, latency
python scripts/ops/actor_concurrency_check.py 20   # proof: 20 concurrent recordCall, counts 1..20, none lost
python scripts/ops/workflow_paths.py        # every workflow path over the chat API except the timeout edge (it needs a real phone call); throwaway assistant copy (sweeps leftovers first; deletes the copy + its TeXML app in finally)
```

`workflow_paths.py` sweeps the account first and deletes any assistant named
`... (path test)` (and its TeXML app), logging each as `WARNING
path.leftover_removed`; in `finally`, each cleanup call runs in its own
`try/except` and logs `ERROR` with a traceback so one failing delete never
leaves a copy behind.

## Troubleshooting

Symptom → log event → fix. Log events are the structured JSON `event` field;
the full table of step 7-11 events is in
[docs/design/OBSERVABILITY.md](../design/OBSERVABILITY.md).

| Symptom | First signal (event / log) | Fix |
| --- | --- | --- |
| The call sounds broken / reads `{{placeholders}}` on air | `webhook.request` with `outcome:"rejected"` (`webhook.rejected reason=signature` or `reason=json`) | Verify `TELNYX_PUBLIC_KEY` matches the Portal's Ed25519 key; check the raw body is forwarded intact to `client.webhooks.unwrap`. |
| Every call is degraded | `webhook.dependency_failed` `dependency=profile` (the actor `recordCall` timed out) and a long `webhook.request duration_ms` near `WEBHOOK_BUDGET_MS` | The actor `recordCall` is slow/down. `dependency=profile` is the actor only — a failed flags read logs `dependency=flags` and falls back to default flags (it does NOT degrade), and the session write runs after the response and logs `webhook.session_write_failed` (no degrade). Telnyx KV over REST takes ~1-4 s/read and ~2 s/write (per the code comment, `func.py:60`) — keep the session write AFTER the response, cache flags 60 s, leave only the actor in the budget. |
| No deals returned | `flytlv.feed_off` ERROR (404, fail-closed) | The `FLYTLV_API_KEY` Edge secret is unset/rejected, or the feed was switched off. Re-add it (`telnyx-edge secrets add FLYTLV_API_KEY ...`); a 404 is a config state, not retried. |
| No deals cache | `mcp.cache_read_failed` WARNING `HTTP 400 Invalid key format` | The cache key has a `|` or `,`. `cacheKey()` should KV-legalise it; if it recurs, the prefix drifted. |
| Tool errors on `save_deal` | tool result with `isError:true` "deal <id> not found in last search results" (a failed save logs NO `mcp.save_deal` — that INFO span is on success only, `server.ts:707`; a `ToolError` returns through `fail()`, `server.ts:557-566`) | The model sent a `deal_id` the actor never saw. Confirm `setLastResults` ran after the last search (the actor only trusts what it stored). |
| Itinerary URL never appears | `itinerary_skipped` WARNING `reason=noITINERARY_BASE_URL` (or `noITINERARIES` / `noSetAlarm`) | The MCP `func.toml` lost `ITINERARY_BASE_URL`, the bucket binding is gone, or the env lacks `setAlarm`. The save still succeeded; only `itineraryUrl` is dropped. (Live bug 7 Oct 08:52 UTC; fix in DECISIONS #28.) |
| Itinerary write fails | `itinerary_write_failed` WARNING with the `error` text | Bucket binding misconfigured or wrong region; a one-off is transient. |
| Reminder never arrives | no `reminder_scheduled` (the alarm was not armed), or `reminder_scheduled` then `alarm.failed` / `alarm.sms_config_missing` / `alarm.deal_missing` | If `reminder_scheduled` is absent, `saveDeal` skipped the alarm (see `itinerary_skipped`). If present, look for the `alarm.*` event `REMINDER_DELAY_SECONDS` later; `alarm.sms_config_missing` = the MCP `func.toml` lost `SMS_FROM` / `MESSAGING_PROFILE_ID`. |
| Reminder fires but no SMS | `alarm.sms_config_missing` WARNING — `env.TELNYX` binding, `smsFrom`, or `messagingProfileId` missing | The reminder is drained to stop the alarm. Today the account blocks the "FlyTLV" sender (long-code senders only); upgrade the account to send. |
| MCP server falls off the shared actor | `mcp.actor.http_fallback` WARNING once per cold start | `USE_SHARED_ACTOR=false` is the only cause (`index.ts:46-47`). A missing `SESSIONS` binding does NOT fall back — `EdgeActor`'s constructor throws and the function fails at boot (`actor.ts:174-183`). Not an error in local debugging; unexpected in production = set `USE_SHARED_ACTOR=true` and add the `[[actors]]` binding. |
| `401` from the MCP server | `mcp.unauthorized reason=bearer mismatch` | The assistant's `MCP_API_KEY` integration secret no longer matches the `MCP_API_KEY` Edge secret. Re-provision the assistant (it stores the secret). |
| `401` from the actor facade | `actor.request status=401` | The webhook/MCP is sending a stale `INTERNAL_API_TOKEN`. Re-share the secret across all three services. |
| `400` from the actor facade | `actor.request`/`dispatch_failed` with `ActorInputError` (e.g. "deal <id> not found in last search results") | Caller's fault — the model sent an input the actor rejects. The body returns the actor's reason. |
| `409 Function Busy` during `ship` | GitHub Actions log | One ship per service at a time; a second concurrent ship is rejected with 409 (the workflow uses `concurrency: group: ship-<service>` to queue). |
| Test assistants pile up | Test runs hitting the TeXML app cap (a small cap) | `workflow_paths.py` sweeps leftovers first; in `finally` each delete is its own try/except. Delete by hand if an older run left one. |
| Live check fails on KV | `mcp.session_read_failed` ERROR `HTTP 401 ... token is expired` | The org API-key binding behind the KV binding expired. Renew it (`PUT /v2/compute/bindings/{id}`). |

## Live endpoints

| What | Where |
| --- | --- |
| Phone | `+972765671113` (Israel) → TeXML app "FLYTLV ai-assistant" → `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16`. Status: bought and linked; Telnyx regulatory approval pending (`requirement-info-pending`). Verified 7 Oct 2026 via `GET /v2/phone_numbers`. |
| Assistant | `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16` — talks on calls with `zai-org/GLM-5.3-Flash` on Telnyx Inference. |
| Webhook | `https://fde-webhook-e5907143-e.telnyxcompute.com` |
| MCP server | `https://fde-mcp-bc3393fa-a.telnyxcompute.com` |
| Session actor | `https://fde-session-actor-94b99eb9-4.telnyxcompute.com` |

## Attribution

OpenCode with Telnyx-hosted models built the first version of every
component and every change from 7 Oct 2026 (steps 7-15) — including this
document. See [README.md, Tool comparison](../../README.md#tool-comparison).
