# FlyTLV Travel Line — Talk Track (what Yaniv says)

What I say out loud on Demo Day, first person, ready to read. Built as build step 27.

Demo Day has three parts (per [docs/challenge/code_challenge.md](../challenge/code_challenge.md)):
1. **Live Demo** (8–10 min) — I drive the live assistant; the run-of-show is
   [DEMO_SCRIPT.md](DEMO_SCRIPT.md). The beats below match that script beat for
   beat.
2. **Live Walkthrough & Decision Review** (7–10 min) — I walk the 9 short-deck
   slides (`deck-short/`, mirrored in [PRESENTATION_SHORT.md](PRESENTATION_SHORT.md)).
3. **Interactive Q&A** (5 min) — 12 prepared answers, each grounded in the code.

Every identifier, number and log line below is copied from the code or from the
verified facts as of 2026-10-12; I invent nothing. Audience: Telnyx engineers.
Tone: confident, technical, positive; I never complain about Telnyx.

Key facts I keep neutral on:
- Phone **+972 76 567 1113** was ordered 6 Oct, documents submitted, still
  pending Telnyx regulatory approval (`requirement-info-exception`). The demo
  call path during the panel is the **Telnyx Portal browser test call** — the
  same assistant, workflow, MCP server and webhook a real dialer would drive.
- Pre-flight as of 2026-10-12: `live_check.py` 23/23 PASS (incl. itinerary link
  200 and fake-token 404); `workflow_paths.py` 15/15 PASS (real chat through
  every workflow path incl. fallbacks over the live assistant);
  `storage_check.py` 2/2 PASS (bucket 2 of 5 objects); account balance
  positive; `telnyx-edge bindings validate <id>` OK for `fde-webhook`
  (`e5907143-e572-4e86-8880-0de76f057561`) and `fde-mcp`
  (`bc3393fa-a5f2-4470-b7af-137f3d9c831d`); Edge binding `TELNYX` valid.
- Transfer to a human (`TRANSFER_TO_NAME`) is **LIVE**: the workflow routes to
  `transfer_call` on request and after `CONVERSATION_TIMEOUT_SECS` (600 s) via
  `timeout_escalate`.
- `send_deal_sms` **has never reached a real phone** on this account — it is
  gated by the KV flag `sms_enabled`. I never claim SMS delivery works. The
  reminder alarm (`setAlarm`) fires regardless; `alarm.sms_sent` logs only on a
  real SMS success.

---

## Opening (~30 s)

> Hi, I'm Yaniv Levy, and I'm interviewing for the Telnyx Forward Deployed
> Engineer role. This is FlyTLV — a phone line that finds cheap round-trip
> flights from Tel Aviv, saves the ones you like, and remembers you on the
> next call. Our number +972 76 567 1113 was ordered on the 6th, documents
> are in, and it's still pending Telnyx regulatory approval — so the demo
> call you'll see runs through the Telnyx Portal browser test call, which
> drives the same assistant, workflow, MCP server and webhook a real dialer
> would. Everything you're about to see runs on Telnyx Edge.

---

## Live Demo (~8–10 min)

Numbered beats. For each: the **caller line** I speak into the Portal test call,
what I **say to the panel** while it runs, and what I **point at on screen**.
Beats and timings match [DEMO_SCRIPT.md](DEMO_SCRIPT.md). Right-screen log tail
running for the whole demo:

```bash
for fn in fde-webhook fde-mcp fde-session-actor; do
  telnyx-edge logs $fn --type runtime --json --tail
done
```

### Beat 1 — Intro (0:00–0:30)

- **Caller line:** *(none — I'm talking to the panel.)*
- **Say to panel:** "This is the FlyTLV Travel Line. People in Israel phone it
  for cheap flights from Tel Aviv, round trip or one way. Behind it: a Telnyx
  AI Assistant with a Conversation Workflow, an MCP server, a Stateful Actor,
  and KV — all on Edge." Point at the architecture diagram:
  **Assistant → Workflow → Edge Function → KV/Actor → MCP**.
- **Point at:** the right-screen log tail (it's live).

### Beat 2 — First call: greeting = speak node + dynamic webhook (0:30–1:15)

- **Caller line:** start the Telnyx Portal browser test call (the phone
  number is pending regulatory approval, so the Portal test call is THE call
  path — it drives the same assistant, workflow, MCP server and webhook as a
  real dialer).
- **Say to panel:** "The greeting is a **speak node** — delivered verbatim, no
  model turn, because the disclosure must not be paraphrased. Telnyx fired the
  webhook **once** at call start to fetch dynamic variables, and the `trace_id`
  you'll see — the conversation id — carries all the way to the actor and the
  MCP server." *(Dynamic webhook: requirement 4a/3.)*
- **Point at:** the webhook log line — `{"event":"span","span":"webhook.request",
  "trace_id":"<conv-id>","duration_ms":212,"outcome":"ok","caller":"***0100",
  "degraded":[]}`.

### Beat 3 — Search flights: workflow routing + MCP tool call (1:15–3:30)

- **Caller line:** **"Something cheap to Cyprus in November."** *(Optionally
  follow up with "Anything for next weekend?" → `weekend=upcoming` server-side
  Thu–Sat dates, then "Cheap flights to Greece" → `country` filter.)*
- **Say to panel:** "That hit `identify_intent` — a **prompt** node — and the
  **LLM edge** ('caller wants to search for cheap flights') routed to
  `search_flights`, another prompt node that calls the **`search_deals` MCP
  tool**. The bot read back Larnaca, Cyprus, 64 dollars round trip, direct,
  on Wizz Air W6 4604, with the times and the return flight. Mid-conversation
  MCP tool call — requirement 2." *(Multi-step workflow: requirement 1. Edge
  in action: requirement 4.)*
- **Point at:**
  - the `mcp.search_deals` INFO span, same `trace_id` as the webhook line;
  - the KV `cache/deals/<sig>` miss → real `GET flytlv.app/api/private/deals`
    (X-API-Key) → cache write *(KV: requirement 4b)*;
  - the actor's `setLastResults` log — the deals read aloud are stored on the
    caller's actor, so a later save can't invent one *(Actor: requirement 4c)*.

### Beat 4 — Save a deal: actor read-modify-write + itinerary page + reminder alarm (3:30–4:30)

- **Caller line:** **"Save the first one."** *(Optional follow-up:
  "Text me that one." — `send_deal_sms`. On this account it has never reached
  a real phone; it's gated by the KV flag `sms_enabled`, so the agent says it
  could not send; the deal is still saved.)*
- **Say to panel:** "`save_deal` (prompt node) → `save_deal` MCP tool → actor
  `saveDeal` — the read-modify-write the actor exists for. KV has no
  compare-and-set, so two concurrent calls from one caller would race; the
  actor serializes the write — that's the **why Actor vs KV** answer.
  `saveDeal` also renders an **itinerary HTML page** to the Cloud Storage
  bucket `flytlv-itineraries` (`itineraries/<slot>-<token>.html`, one slot per
  caller, 4 slots + 1 audit key = 5 objects, the bucket cap), and arms the
  actor's single **alarm** to send a follow-up SMS `REMINDER_DELAY_SECONDS`
  (default 600 = 10 min) later. The profile comes back with `itineraryUrl`,
  which `save_deal` surfaces to the model so the caller hears the link."
- **Point at:**
  - the `saveDeal` log: `savedCount` increments, `lastSaved` becomes the
    shown deal;
  - the `actor_concurrency_check.py 20` proof line — 20 concurrent
    recordCalls return 1..20, none lost (run from a side terminal);
  - `reminder_scheduled` INFO with `delay_ms:600000` (the alarm arming);
  - `itineraryUrl` in the save response (and the GET 200 on the link).

### Beat 5 — Second call: "Welcome back" = the whole chain, personalized (4:30–6:00)

- **Caller line:** start a **new conversation in the Portal test call from the
  same test number** (same caller → same actor instance → `callCount` 2).
- **Say to panel:** "That one sentence — 'Welcome back — last time you saved
  Larnaca for 64 dollars' — is the whole chain in one line. The webhook fired
  → `recordCall` on the same actor instance → `callCount` 2 and `lastSaved`
  = the saved Larnaca deal → the webhook turned that into `last_saved_deal =
  "Larnaca, 64 USD"` and `caller_known = "true"` dynamic variables → the
  `identify_intent` prompt interpolated them into the welcome-back line.
  Per-caller typed state on the actor, surfaced through the dynamic webhook
  into the workflow." *(Requirements 3 & 4a.)*
- **Point at:**
  - the second webhook log line for the same `caller`,
  - the actor `recordCall` log returning `callCount: 2`,
  - the `last_saved_deal` and `caller_known` dynamic variables in the
    webhook response.

### Beat 6 — Edge Compute in action: point at the platform (6:00–7:00)

- **Caller line:** *(none.)*
- **Say to panel:** "Three deployed services. `fde-webhook` —
  `https://fde-webhook-e5907143-e.telnyxcompute.com`, Python 3.9 Edge Function.
  `fde-mcp` — `https://fde-mcp-bc3393fa-a.telnyxcompute.com`, TypeScript Edge
  Function running the official `@modelcontextprotocol/sdk`. `fde-session-actor`
  — `https://fde-session-actor-94b99eb9-4.telnyxcompute.com`, the Stateful
  Actors on the Edge actor runtime hosting three classes: CallerSession,
  MetricsCounter and AuditLog. The webhook is the canary — every call hits it
  first. KV reads/writes hit the `fde-kv` namespace; actor storage holds
  `callCount` / `lastResults` / `savedDeals` / `searchHistory` /
  `pendingReminder` / `itineraryToken`." *(Requirements 4a, 4b, 4c.)*
- **Point at:**
  - `telnyx-edge metrics fde-webhook` — request count, 2xx, p50/p95;
  - `python scripts/ops/metrics.py` — our own counters from the
    MetricsCounter actor (tool calls, cache hits, degraded rate, latency per
    tool).

### Beat 7 — Observability: one trace, end-to-end + the one bug (7:00–8:30)

- **Caller line:** *(none.)*
- **Say to panel:** "Pick the conversation id from any line and glue the whole
  call together — `webhook.request` → `recordCall` → `mcp.search_deals` →
  `saveDeal`, all under one `trace_id`, every latency span visible across all
  three services. One real bug and the signal that exposed it: the **hardest
  bug** was the itinerary URL and reminder never appearing on a save. The
  signal was a single JSON log line — `itinerary_skipped` with
  `reason=noITINERARY_BASE_URL` on every save. Root cause: the actor's
  umbrella `telnyx.toml [env_vars]` never reach actor instances' `process.env`,
  while the Cloud Storage bucket binding does. Fix: the MCP server forwards
  `ITINERARY_BASE_URL`, `REMINDER_DELAY_SECONDS`, `SMS_FROM` and
  `SMS_PROFILE_ID` on every `saveDeal` call (in the `config` field), and the
  actor resolves `config.X ?? process.env.X` — `process.env` stays the fallback
  for unit tests, local dev, and the day the platform honours the actor
  umbrella. After the fix, `itineraryUrl` returns, `reminder_scheduled` fires,
  and a `check_itinerary.mts` case with no `process.env` passes end to end."
  *(Requirement 5.)*
- **Point at:**
  - the `itinerary_skipped` WARNING line in the actor logs;
  - the `jq -c 'select(.trace_id=="<conv-id>")'` result across the three
    services (all three logs under one id).

### Beat 8 — Fallback path: flip a KV flag live = expression edge (8:30–9:30)

- **Caller line:** flip the deals flag to false, then start a new
  conversation in the Portal test call. Optionally say:
  **"Can I speak to a person?"** to trigger the transfer.
- **Say to panel:** "I flipped `flags/assistant` `{"deals_enabled":false}`
  with no redeploy. The webhook reads the new flag, returns
  `flag_deals_enabled="false"`, and the `identify_intent` hub routes via the
  **expression edge** to the `deals_disabled` **speak node** — 'Flight deal
  search is temporarily turned off. Please call back later.' That edge is
  deterministic, evaluated *before* the model turn — a broken or disabled
  backend never depends on the model noticing it (decision #12). Flip back to
  `true` and a fresh conversation returns to the happy path. Escalation:
  'Can I speak to a person?' → the workflow routes to `transfer_call`,
  offers `TRANSFER_TO_NAME`, and a separate `hangup_call` tool node ends the
  call so the model can't hang up by mistake. Transfer is **live** across the
  chat path too — `workflow_paths.py` 15/15 PASS includes the transfer offer."
  *(Requirements 5 happy + fallback; KV-flag stretch.)*
- **Point at:**
  - the `telnyx-edge storage kv put flags/assistant '{"deals_enabled":false}'`
    command;
  - the next `webhook.request` with `flag_deals_enabled="false"` in its
    response, then the deals_disabled reply from the assistant;
  - on the transfer ask, the `transfer_call` node reply offering the human,
    and the hangup tool firing in the workflow log.

### Beat 9 — Close (9:30–10:00)

- **Caller line:** *(none.)*
- **Say to panel:** "Everything you saw runs on Telnyx: the workflow, the
  MCP server, the Stateful Actor and KV — all on Edge. OpenCode with
  Telnyx-hosted models built the first version of every service (GLM-5.2;
  Kimi-K3 for the webhook), and every change since 7 Oct is an OpenCode
  build step (`docs/build/PROMPTS.md`). Here's the config — `opencode.json`
  plus the `/telnyx` model list — bridging into the walkthrough."

---

## Live Walkthrough & Decision Review (~7–10 min)

I talk through the 9 short-deck slides (`deck-short/slides/*.html`, mirrored in
[PRESENTATION_SHORT.md](PRESENTATION_SHORT.md)). One spoken paragraph per
slide; every identifier on the slide is the real one from the code.

### Slide 1 — Cover (~30 s)

> FlyTLV Travel Line. Phone +972 76 567 1113 — bought and linked, regulatory
> approval pending, so the demo runs through the Portal browser test call.
> Three live Edge services: the Python 3.9 webhook at
> `fde-webhook-e5907143-e.telnyxcompute.com`, the TypeScript MCP server at
> `fde-mcp-bc3393fa-a.telnyxcompute.com`, and the TypeScript Stateful Actors
> at `fde-session-actor-94b99eb9-4.telnyxcompute.com`. The assistant talks on
> `ASSISTANT_MODEL = zai-org/GLM-5.3-Flash` over Telnyx Inference. Why:
> Tel Aviv fares move fast, a thirty-second call beats browsing.

### Slide 2 — Architecture (~50 s)

> Bindings and hops matter. The Python webhook can't bind actors, so it
> reaches the session-actor through an **HTTP facade**
> (`POST /actors/{digits}/{method}` with a Bearer `INTERNAL_API_TOKEN`).
> The TypeScript MCP server skips that hop: it binds CallerSession directly
> through the `env.SESSIONS` **shared-actor** binding — no class code
> shipped by the MCP function; the runtime forwards the call over RPC. KV
> is REST from the Python webhook (`client.storage.kvs.keys.*`) and the
> `env.KV` binding from the TypeScript MCP. The session-actor service
> writes one **Cloud Storage** bucket, `flytlv-itineraries`, hard-capped
> at 5 objects: 4 itinerary slots + one `audit/latest.json`.
> Three actor classes, all hosted by session-actor: CallerSession,
> MetricsCounter and AuditLog.

### Slide 3 — Workflow & Edges (~60 s)

> The workflow is `build_flow()` in `assistant/flow.py`: 12 nodes — 4 speak
> (`greeting`, `degraded_notice`, `deals_disabled`, `farewell`), 7 prompt
> (`identify_intent`, `search_flights`, `save_deal`, `list_saved`,
> `answer_faq`, `transfer_call`, `timeout_escalate`), and 1 tool
> (`hangup_call`). 26 edges — 3 expression, 19 LLM, 4 default. The three
> expression edges are deterministic, evaluated before the model turn:
> `backend_degraded == "true"` → `degraded_notice`;
> `flag_deals_enabled == "false"` → `deals_disabled`;
> `telnyx_conversation_duration_secs >= 600` → `timeout_escalate`.
> Declaration order is priority order, so expression edges win over LLM
> edges at `identify_intent`. `instructions_mode` is `append` by default
> and `replace` only on `timeout_escalate` and `hangup_call`.
> `validate()` checks the graph statically: start node exists, no
> duplicate ids, every edge target is known, the condition is one of
> `{llm, expression, default}`, and every speak node has exactly one
> default edge.

### Slide 4 — MCP server (~50 s)

> Four tools: `search_deals`, `save_deal`, `list_saved_deals`,
> `send_deal_sms`. The server uses the official `@modelcontextprotocol/sdk`
> with a fresh `McpServer` + stateless
> `StreamableHTTPServerTransport({sessionIdGenerator: undefined,
> enableJsonResponse: true})` per request — Edge has no request lifespan.
> Bearer `MCP_API_KEY` is checked before the transport; tool failures return
> `{isError: true}` with a caller-friendly message, never a traceback or URL.
> Each tool resolves the caller from `params._meta.telnyx_conversation_id`
> → KV `session/<conv_id>` → `entity_id` → `env.SESSIONS`, so phone numbers
> never appear in tool arguments. flytlv is `GET /api/private/deals` with
> `X-API-Key`, 3000 ms timeout + 1 retry on `TimeoutError`, and the
> `bookable()` filter drops flights leaving < 3 h
> (`MIN_HOURS_BEFORE_DEPARTURE`). Weekend dates are computed server-side
> (`weekendDates("upcoming"|"following")` → Thu/Fri/Sat dates).

### Slide 5 — Dynamic Webhook Variables (~50 s)

> The webhook overrides the assistant's default variables at call start. The
> response shape is `{"dynamic_variables": {caller_known, call_count,
> saved_count, last_saved_deal, backend_degraded, flag_deals_enabled,
> flag_sms_enabled, flag_promo}}` — strings only. Signature verification
> happens first: `client.webhooks.unwrap(body, headers)` BEFORE `json.loads`
> — bad signature → 401, bad JSON → 400, so an unsigned body never reaches
> parsing. `_fetch_context` runs `_flags(kv)` and
> `actor.call(entity, "recordCall")` in parallel under
> `WEBHOOK_BUDGET_MS=2500`, below the assistant's
> `WEBHOOK_TIMEOUT_MS=8000`. On any actor or KV failure, safe defaults
> (`backend_degraded="true"`, `caller_known=false`, `call_count=0`) route
> the call to a scripted `degraded_notice` instead of reading raw placeholders
> on air. The session KV write runs after the response so it never blocks.

### Slide 6 — State (~60 s)

> Pick the cheapest primitive that is correct. KV for read-mostly flags
> (`flags/assistant`, 60 s in-process cache), the deals cache
> (`cache/deals/<sig>`, TTL 300 s) and the one-write session map
> (`session/<conv>`, TTL 3600 s) — the latter keeps the phone number out of
> LLM arguments. The CallerSession actor — `idFromName(digits)` — for
> per-caller read-modify-write: `callCount`, `lastResults`, `savedDeals`,
> `pendingReminder`, `searchHistory`, `itineraryToken`, plus `setAlarm` for
> the reminder. MetricsCounter (`"global"`) for concurrent service counters;
> KV would lose some. AuditLog singleton writes `audit/latest.json` (last
> 200 events) and shares the bucket with 4 itinerary slot keys — 4 + 1 = 5
> objects, never growing. Proof: 20 concurrent `recordCall` requests
> return counts 1–20 with none lost, live today.

### Slide 7 — The hardest bug (~70 s)

> The signal was a single JSON log line: `itinerary_skipped` with
> `reason=noITINERARY_BASE_URL`. Root cause: the actor's umbrella
> `telnyx.toml [env_vars]` do not reach actor instances' `process.env`
> (a live platform finding, step 11), while the Cloud Storage bucket
> binding does. Fix: the MCP server forwards `ITINERARY_BASE_URL`,
> `REMINDER_DELAY_SECONDS`, `SMS_FROM` and `SMS_PROFILE_ID` on every
> `saveDeal` call inside the `config` field, and the actor resolves
> `config.X ?? process.env.X`. Evidence: `itineraryUrl` now returns,
> `reminder_scheduled` fires, and a `check_itinerary.mts` case with no
> `process.env` passes. Two more silent failures: **TooManyObjects** — the
> bucket's 5-object cap was hit during writes while `live_check` stayed
> green; fixed by only writing 4 slot keys + one `audit/latest.json`, with
> `storage_check.py` guarding the cap. And **slow KV** (commit 11bff7e):
> every call was degraded by 1.2–3.7 s REST reads; fixed by caching flags,
> running the session write after the response, and raising the webhook
> budget to 2500 ms.

### Slide 8 — Building with Telnyx Inference via OpenCode (~60 s)

> Command: `opencode run --model 'telnyx/zai-org/GLM-5.2' "<prompt>"`. Cost
> env: `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` with a clean XDG config dir cut
> requests from ~215k to ~8.7k tokens. Models per part: **GLM-5.2** built
> the shared code, the MCP server, the assistant flow, the session actor
> and the docs; **Kimi-K3** built webhook v1; **GLM-5.3-Flash** is
> `ASSISTANT_MODEL` — the LLM on the calls themselves. Step loop: write
> the prompt in `docs/build/PROMPTS.md` → run OpenCode → run tests →
> review → commit. Honest attribution: OpenCode with Telnyx models built
> the first version of every service; since 7 Oct every change is an
> OpenCode build step.

### Slide 9 — Edge cases and next steps (~50 s)

> Edge cases handled by the code: bad signature → 401, bad JSON → 400;
> KV or actor failure → `backend_degraded="true"` → `degraded_notice` speak
> node; flytlv timeout 3000 ms + 1 retry on `TimeoutError`;
> `flag_deals_enabled="false"` → `deals_disabled`; MCP failures →
> `{isError: true}` with a caller-friendly message; `send_deal_sms` only
> texts the caller's own number and only for a deal in `lastResults`,
> gated by `sms_enabled`. Shipped extras: live transfer tool
> (`TRANSFER_TO_NAME`), 23-entry FAQ, KV read retry, `live_check` 23/23,
> `storage_check`, `metrics.py`, CI per service, logs in Israel time.
> Next, two true items not already built: per-deal reminders via a
> `CronTick` actor (today one alarm per caller) and a flight-status branch.

---

## Interactive Q&A (~5 min) — 12 prepared answers

Twelve most likely questions from the brief's list, each with a 2–4 sentence
answer grounded in the code.

### Q1. Why Stateful Actor vs KV vs plain function logic for each piece of state?

KV wins for read-mostly flags (`flags/assistant`, cached 60 s in-process), the
deals cache (`cache/deals/<sig>`, TTL 300 s), and the one-write session map
(`session/<conv>`, TTL 3600 s) — the latter keeps the phone number out of LLM
arguments. The `CallerSession` actor (`idFromName(digits)`) wins for per-caller
read-modify-write — `callCount`, `savedDeals`, `searchHistory`,
`pendingReminder` — because KV has no compare-and-set and two concurrent calls
from one caller would race. `MetricsCounter` ("global") and `AuditLog`
(singleton) are actors for the same reason: Edge scales to zero and KV would
lose concurrent increments; the actor serializes. Proven live by 20 concurrent
`recordCall` requests returning 1..20 with none lost.

### Q2. How did you use OpenCode + Telnyx Inference, and what model(s) did you choose?

`opencode run --model 'telnyx/zai-org/GLM-5.2' "<prompt>"` runs each build step.
**GLM-5.2** built the shared code, MCP server, assistant flow, session actor
and docs; **Kimi-K3** built webhook v1; **GLM-5.3-Flash** is `ASSISTANT_MODEL` —
the assistant's LLM on calls. Test-first prompts against the acceptance tests
produced passing code in a few iterations; GLM-5.2 handled multi-file work
well, including the MCP port from Python to TypeScript. Since 7 Oct every
change is an OpenCode build step (`docs/build/PROMPTS.md`).

### Q3. What was the hardest bug, and what signal exposed it?

Symptom: on every save the itinerary URL and SMS reminder never appeared.
Signal: one JSON log line — `itinerary_skipped` with `reason=noITINERARY_BASE_URL`
on every save. Root cause: the actor's umbrella `telnyx.toml [env_vars]` do not
reach actor instances' `process.env`, while the Cloud Storage bucket binding
does. Fix: the MCP server forwards `ITINERARY_BASE_URL`,
`REMINDER_DELAY_SECONDS`, `SMS_FROM` and `SMS_PROFILE_ID` on every `saveDeal`
call (in the `config` field), and the actor resolves `config.X ?? process.env.X`.
Evidence: `itineraryUrl` now returns, `reminder_scheduled` fires, and a
`check_itinerary.mts` case with no `process.env` passes end to end.

### Q4. LLM conditions vs variable comparisons for routing — what did you decide?

Three expression edges — `backend_degraded == "true"`,
`flag_deals_enabled == "false"`, `telnyx_conversation_duration_secs >= 600` —
are deterministic facts, evaluated before the model turn so a degraded backend
or a disabled feature routes to a scripted notice without the model noticing.
LLM edges handle intent, where the caller's words vary. Declaration order is
priority order, so the three expression edges win at the `identify_intent` hub
before the five LLM edges. The trade: less flexible routing for a real safety
property — a broken backend is self-protecting.

### Q5. How did you handle edge cases and errors?

The webhook verifies the Ed25519 signature before parsing — bad signature →
401, bad JSON → 400. Any KV or actor failure sets `backend_degraded="true"` →
the `degraded_notice` speak node. flytlv times out at 3000 ms with one retry
on `TimeoutError`; `flag_deals_enabled="false"` → `deals_disabled`; MCP tool
failures return `{isError: true}` with a caller-friendly message, never a
traceback or URL. `send_deal_sms` only texts the caller's own number and only
for a deal in `lastResults`, gated by the `sms_enabled` KV flag. Hidden caller
id still gets deals (the webhook returns a note; nothing is saved). Re-saving
the same deal is deduped on the actor.

### Q6. How does this scale?

KV is horizontally scalable for read-mostly flags (60 s in-process cache) and
the deals cache (TTL 300 s), so they don't bottleneck. The per-caller actor is
sharded by caller id — two callers don't share an instance — so per-caller
contention is the only real read-modify-write hotspot, and it's atomic.
`MetricsCounter` ("global") would shard by hour at higher throughput, and
`AuditLog` is a singleton bounded by the 5-object Cloud Storage cap, so I
overwrite one `audit/latest.json` (last 200 events). The Cloud Storage cap is
the one constraint I work within: 4 slot keys + 1 audit key, always
overwritten, never growing.

### Q7. Multi-assistant routing — why isn't it done?

It's the one stretch goal I didn't ship. The workflow has `transfer_call`
(prompt node) that offers a transfer to `TRANSFER_TO_NAME` and a shared
`hangup_call` tool node after it, but it transfers to a **human agent**, not a
second assistant persona. A second persona would need: a second workflow, an
expression edge on a per-caller KV flag to route to it, a second provision
pass. The architecture supports it (the workflow schema allows many
assistants; the actor can hold a per-caller persona preference), but the scope
didn't fit the build window. It's the cleanest "next" item after the
flight-status branch.

### Q8. How is the webhook/MCP secured?

The webhook verifies the Ed25519 signature with `client.webhooks.unwrap(body,
headers)` BEFORE `json.loads` — an unsigned body never reaches JSON parsing.
The actor's HTTP facade (used by the Python webhook) and the MCP server both
require Bearer tokens (`INTERNAL_API_TOKEN`, `MCP_API_KEY`), checked before
any work. The phone number lives only in the KV session map and the actor id
— never in tool arguments or LLM prompts; MCP resolves
`params._meta.telnyx_conversation_id → session/<conv> → entity_id →
env.SESSIONS`. Tool failures return caller-friendly messages, never
tracebacks, URLs, or keys. `send_deal_sms` texts only the caller's own number
and only for an offered deal, gated by `sms_enabled`.

### Q9. What did this cost?

OpenCode + Telnyx Inference ran the build steps; a negative balance stops
inference mid-step with error 20015 — two steps were rerun. Global context
blew requests to ~215k tokens until `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` with
a clean XDG config dir cut it to ~8.7k per request. On the runtime side:
flag reads are cached 60 s in-process on the webhook to cut KV calls; the
deals cache (TTL 300 s) avoids repeat flytlv calls; the session KV write runs
after the webhook response so it never blocks; the MCP server uses the
shared-actor RPC hop directly (no HTTP facade round-trip).

### Q10. What would you do next?

Three things, all not-yet-built. **Per-deal reminders** — today one alarm per
caller means a newer save replaces the reminder; a `CronTick` actor would
schedule one reminder per saved deal. **A flight-status branch** — a new
prompt node that calls a new MCP tool over a flytlv status endpoint,
returning delays and cancellations. **Multi-assistant routing** — a second
assistant persona via an expression edge on a per-caller flag. Smaller:
shard `MetricsCounter` by hour at higher load, and roll `AuditLog` past 200
events to S3 cold storage.

### Q11. Is it production-ready?

It's demo-ready: today `live_check.py` is 23/23 PASS (incl. itinerary link
200 and fake-token 404), `workflow_paths.py` is 15/15 PASS over the live
assistant (incl. fallbacks and the transfer offer), `storage_check.py` is
2/2 PASS (bucket 2 of 5 objects), and CI ships each service from Linux via
GitHub Actions (the Windows CLI zips backslashes). What's between demo and
production: the phone number pending regulatory approval; `send_deal_sms`
never reaching a real phone (gated by `sms_enabled`); per-deal reminders not
yet; the AuditLog singleton could roll past 200 events; and per-tool rate
limiting on the MCP server.

### Q12. What's your testing strategy?

Three layers. **Unit tests** use fakes against the acceptance tests
(`tests/check_*.py`), run in CI — they pin `build_flow`, `validate`, the
MCP server's `createServer`, the webhook's `_dynamic_variables`, the actor's
save and alarm paths. **Workflow capability tests** assert the graph
statically: start node exists, no duplicate ids, edge targets known,
condition ∈ `{llm, expression, default}`, every speak node has exactly one
default edge. **Live checks** hit real Edge services: `live_check.py` runs
23 checks (webhook, MCP, actor, KV, itinerary URL 200 + fake-token 404, the
`sms_enabled` KV flag), `workflow_paths.py` drives 15 real chat conversations
through every workflow path incl. fallbacks, and `storage_check.py` guards
the bucket's 5-object cap. The actor concurrency proof (20 concurrent
`recordCall` → 1..20 with none lost) is in `live_check`.

---

## Closing (~20 s)

> Thanks — that's FlyTLV: workflow, MCP, Stateful Actor and KV, all on
> Telnyx Edge, built with Telnyx-hosted models via OpenCode. I'll take your
> questions.
