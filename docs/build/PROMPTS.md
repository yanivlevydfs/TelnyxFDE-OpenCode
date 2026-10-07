# Build prompts for OpenCode (Telnyx Inference)

Run each prompt in order, in this folder, with a Telnyx-hosted model. Example:

```bash
opencode run --model 'telnyx/zai-org/GLM-5.2' "<prompt>"
```

or paste them into the OpenCode TUI (`opencode`, then `/telnyx` to pick the model).
`AGENTS.md` (rules, structure, platform facts) is loaded automatically.

Models enabled in `~/.config/opencode/telnyx-models.json`: `moonshotai/Kimi-K3`,
`moonshotai/Kimi-K2.6`, `zai-org/GLM-5.3`, `zai-org/GLM-5.2`, `zai-org/GLM-5.1-FP8`,
`deepseek-ai/DeepSeek-V4.1-Flash`, `Qwen/Qwen3.8-27B`, `MiniMaxAI/MiniMax-M2.7`,
`MiniMaxAI/MiniMax-M3-MXFP8`.

Inference is billed to the Telnyx account. If the balance goes negative, Telnyx returns
`20015 "User account is not enabled for inference"` and OpenCode stops mid-step.

## Status

| Step | Component | Model | Result |
| --- | --- | --- | --- |
| 1 | Shared code | GLM-5.2 | Done: 13/13 tests pass |
| 2 | Webhook | Kimi-K3 | Done: 9/9 tests pass; `func.toml` fixed to the official format |
| 3 | MCP server | GLM-5.2 | Stopped by error 20015 before writing files; rerun |
| 4 | Session actor | GLM-5.3 | Stopped by error 20015; rerun |
| 5 | Assistant + workflow | — | Not started |
| 6 | Docs | — | Not started |

## 1. Shared code

Read AGENTS.md and tests/test_common.py. Write shared/common.py so every test in
tests/test_common.py passes. Run `.venv/Scripts/python -m pytest tests/test_common.py -q`
and fix until green. Then write scripts/build/vendor_shared.py.

## 2. Webhook

Read AGENTS.md, docs/design/ and tests/test_webhook.py. Build services/webhook (function/func.py,
function/__init__.py, pyproject.toml, func.toml, README.md). Run
`python scripts/build/vendor_shared.py` then `.venv/Scripts/python -m pytest tests/test_webhook.py -q`
and fix until green.

## 3. MCP server

Read AGENTS.md and tests/test_mcp.py. Build services/mcp-server with the official mcp SDK
and the three tools search_deals, save_deal, list_saved_deals. Use the official `func.toml`
format from AGENTS.md with the registered `fde-mcp` func_id. Make tests/test_mcp.py pass.

## 4. Session actor

Read AGENTS.md and tests/test_session_actor.test.mts. Build services/session-actor
(src/caller-session.ts, src/index.ts, telnyx.toml, package.json with "test": "tsx --test
../../tests/test_session_actor.test.mts", tsconfig.json). `recordCall` must return the
full profile (callCount, savedCount, lastSaved). Run npm install and npm test until green.

## 5. Assistant + workflow

Read AGENTS.md and tests/test_assistant.py. Build assistant/flow.py and assistant/provision.py
(Telnyx SDK). Make tests/test_assistant.py pass.

## 6. Docs

Update README.md: architecture diagram, workflow table, how I'd know within a minute that the
assistant is broken, setup and deploy steps. Note which Telnyx model built each component.

## Small fixes queued

- shared/common.py: read the trace header name from `TRACE_HEADER` (default `x-trace-id`)
  instead of hardcoding it. Keep tests/test_common.py green.

## 7. Itinerary file (Cloud Storage) + follow-up reminder (actor alarm)

Read AGENTS.md, services/session-actor/ and services/mcp-server/src/server.ts. When the caller
picks a flight (the `saveDeal` actor method, used by both `save_deal` and `send_deal_sms`):

1. **Itinerary file in Telnyx Cloud Storage.** In `CallerSession.saveDeal`, render a small,
   mobile-friendly HTML itinerary page for the chosen deal (city, country, dates, airline,
   direct or not, price + currency, booking link; escape every value) and `put` it into the
   bucket binding `this.env.ITINERARIES` under key `itineraries/<crypto.randomUUID()>.html`
   with `httpMetadata.contentType = "text/html; charset=utf-8"`. Keep a map dealId -> key in
   actor storage so re-saving a deal reuses its file. Add `itineraryUrl` to the profile
   `saveDeal` returns: `${process.env.ITINERARY_BASE_URL}/itineraries/<uuid>.html`.
2. **Public read route.** In src/index.ts add `GET /itineraries/<uuid>.html` (no bearer: the
   random UUID is the capability; validate it with a strict UUID regex, 404 otherwise) that
   streams the object from `env.ITINERARIES` with its content type. Everything else is unchanged.
3. **Follow-up reminder via alarm.** After saving, store `{dealId, itineraryUrl}` as the pending
   reminder and `await this.ctx.storage.setAlarm(Date.now() + REMINDER_DELAY_SECONDS*1000)`
   (env var, default 600). Override `async alarm(info: AlarmInfo)`: re-read the pending reminder
   (at-least-once delivery: return if none), send one SMS to `+<actor id digits>` through
   `this.env.TELNYX.messages.send({from: SMS_FROM, to, text, messaging_profile_id:
   MESSAGING_PROFILE_ID})` ("Still thinking about <city> for <price> <currency>? Your itinerary:
   <url>"), then delete the pending reminder. Never throw from `alarm()` (a throw loses the
   alarm after 3 retries): catch, log ERROR with the stack, and return. One alarm per actor:
   a newer save replaces the reminder. Mark that with a `ponytail:` comment.
4. **Never break a save.** If the bucket binding, `setAlarm` or `ITINERARY_BASE_URL` is missing
   (unit tests pass `{}` as env and a ctx without `setAlarm`), log WARNING and still return the
   profile without `itineraryUrl`. tests/test_session_actor.test.mts must stay green unedited.
5. **telnyx.toml:** add `[telnyx] binding = "TELNYX"`, `[storage.cloudstorage.ITINERARIES]`
   with `bucket_name = "flytlv-itineraries"` and `region = "us-central-1"`, and `[env_vars]`
   `ITINERARY_BASE_URL = "https://fde-session-actor-94b99eb9-4.telnyxcompute.com"`,
   `REMINDER_DELAY_SECONDS = "600"`, `SMS_FROM = "FlyTLV"`,
   `MESSAGING_PROFILE_ID = "4001a112-28fd-40f5-a0de-226b1bad6b80"`.
6. **MCP:** `save_deal` returns `itineraryUrl` from the actor's response when present;
   `send_deal_sms` appends "Itinerary: <url>" to the SMS text when present. tests/test_mcp.test.mts
   stays green unedited.
7. Add a NEW self-check `tests/check_itinerary.mts` (do not edit existing tests) with fakes for
   ctx.storage (+ setAlarm), a bucket, and env.TELNYX: saveDeal writes one HTML object and
   returns its URL; re-save reuses it; alarm() sends exactly one SMS and a second alarm() sends
   none; the GET route returns the HTML and 404s a bad id. Add `"check": "tsx --test
   ../../tests/check_itinerary.mts"` to services/session-actor/package.json.
8. Update services/session-actor/README.md. Run `npm test`, `npm run check` and
   `npm run typecheck` in services/session-actor, and `npm test` + `npm run typecheck` in
   services/mcp-server. Fix until all green.

Platform facts (verified in @telnyx/edge-runtime 0.16 typings and Telnyx docs):
`ctx.storage.setAlarm(ms) / getAlarm() / deleteAlarm()`, one alarm per instance, at-least-once,
3 redrives then dropped, `import type { AlarmInfo, CloudStorageBucket } from "@telnyx/edge-runtime"`.
`CloudStorageBucket.put(key, body, {httpMetadata})`, `get(key)` returns an object with `body`
(ReadableStream) and `writeHttpMetadata(headers)`, or null.

## 8. Shared actor: the MCP server binds CallerSession directly

Telnyx "shared actors": one function owns the class (fde-session-actor); other functions on
the same account declare the same `type` under their own `binding` and ship no class code.
In services/mcp-server: add to func.toml `[[actors]] binding = "SESSIONS"  type = "CallerSession"`;
add `EdgeActor implements Actor` in src/actor.ts that calls
`env.SESSIONS.idFromName(entityId)[method](body)` (import `env` from "@telnyx/edge-runtime"; do
NOT import the CallerSession class). Over the RPC hop an actor `ActorInputError` arrives as a
plain Error whose message embeds `"name":"ActorInputError"`: map that to the MCP
`ActorInputError`, anything else to `ActorError`. Use `EdgeActor` in src/index.ts when
`USE_SHARED_ACTOR` is on (flag, default "true" in func.toml `[env_vars]`), else `ActorClient`
(the HTTP facade stays for the Python webhook, which cannot bind actors). Keep tests green; update
the MCP README and docs/design/ARCHITECTURE.md.

## 9. Assistant flow upgrade (full capability list)

Read AGENTS.md, assistant/flow.py, assistant/provision.py, assistant/README.md,
tests/test_assistant.py and the MCP tool schemas in services/mcp-server/src/server.ts (read only).
Upgrade the Conversation Workflow and the assistant instructions so the agent supports:

- **Flight search:** from TLV; a named destination; global discovery ("anywhere cheap"); one-way
  and round trip; direct and connecting; cheapest first; flexible dates and date ranges.
- **Travel patterns:** mid-week, weekend, long weekend, short break, 4–5 day trip, 7-day trip,
  flexible. Map each one to concrete search_deals arguments (dates, nights, trip type), using only
  arguments the tool really has.
- **Conversation:** natural follow-up questions, keep context for the whole call, refine
  preferences, compare prices and destinations, offer alternatives when nothing matches.
- **Actions:** give the booking link, send it by SMS (send_deal_sms), transfer to a human agent,
  end the call.
- **Safety / accuracy:** never invent availability or prices (speak only tool results); never claim
  a booking was completed (the caller books on flytlv.app themselves); say clearly "I found a
  flight" and never "you are booked"; say that prices can change; read back destination, dates,
  price and direct/connecting and get a yes before sending the link.

Rules: edit ONLY files under assistant/ (another agent is editing services/ right now). Keep
tests/test_assistant.py green and unedited, and keep `.venv/Scripts/python assistant/provision.py
--dry-run` working. Do NOT run a live provision. Add a NEW self-check
`tests/check_flow_capabilities.py` that builds the flow and asserts each capability above is
covered (a node, an edge or an instruction line). If a capability needs an MCP tool argument that
does not exist, do not fake it: list the gap in assistant/README.md under "MCP gaps".
Run `.venv/Scripts/python -m pytest tests/test_assistant.py -q` and the new check until green.

## 10. Root README update

Read README.md, docs/design/ARCHITECTURE.md, and the READMEs of services/session-actor,
services/mcp-server and assistant/. Update the ROOT README.md (keep its structure and tone) so it
covers what steps 7-9 added:
- the itinerary HTML page written to Telnyx Cloud Storage (bucket `flytlv-itineraries`) when the
  caller picks a flight, served at `GET /itineraries/<uuid>.html` on the session-actor function;
- the follow-up reminder SMS scheduled with a Stateful Actor alarm (REMINDER_DELAY_SECONDS);
- shared actors: the MCP server binds CallerSession directly (`SESSIONS`), the Python webhook keeps
  using the HTTP facade; the metrics counter still goes over HTTP, so ACTOR_SERVICE_URL and
  INTERNAL_API_TOKEN stay required for the MCP server (fix the func.toml comment that says
  otherwise);
- the upgraded assistant flow capabilities and its safety rules (never invent prices or
  availability, never claim a booking, prices can change, confirm details before sending a link);
- add to the architecture diagram / component table where they exist.
Attribution must be true: steps 7, 8 and 9 were built by OpenCode with Telnyx zai-org/GLM-5.2 (the
first step 9 attempt with Kimi-K3 hung and was stopped). Do not change any code except the
func.toml comment.

### 10b. Assistant model line

In README.md the "Assistant" row reads `assistant-77f5cfdc-... (GLM-5.3-Flash)`, which looks like
the model that BUILT it. Make it say the assistant TALKS on calls with `zai-org/GLM-5.3-Flash` on
Telnyx Inference (verified by GET /v2/ai/assistants/{id}: model zai-org/GLM-5.3-Flash,
external_llm null), and that its code (assistant/flow.py, provision.py) was written by OpenCode with
Telnyx GLM-5.2. Change nothing else.

## 11. Fix: actor config arrives with the call (live bug)

Live finding after the step 7-8 deploy (actor log, 7 Oct 08:52 UTC):
`itinerary_skipped reason=noITINERARY_BASE_URL`. The `[storage.cloudstorage.ITINERARIES]` binding
reaches the actor, but the umbrella telnyx.toml `[env_vars]` do NOT reach actor instances'
`process.env`, while the MCP server's func.toml `[env_vars]` do work.

Fix (keep it small):
- services/mcp-server/func.toml `[env_vars]`: add `ITINERARY_BASE_URL`, `REMINDER_DELAY_SECONDS`
  (move the values from services/session-actor/telnyx.toml); `SMS_FROM` and
  `MESSAGING_PROFILE_ID` are already there.
- services/mcp-server/src/server.ts: every `saveDeal` actor call sends
  `{dealId, config: {itineraryBaseUrl, reminderDelaySeconds, smsFrom, messagingProfileId}}` read
  with `config.optional(...)` (omit empty values).
- services/session-actor/src/caller-session.ts: `saveDeal(input: {dealId, config?})` uses
  `input.config.X ?? process.env.X` for each value; validate types (strings, a positive number) and
  ignore bad ones. Store `smsFrom` and `messagingProfileId` inside the pending reminder so `alarm()`
  reads them from storage, falling back to process.env.
- services/session-actor/telnyx.toml: keep `[env_vars]` but add a comment with the live finding.
- Extend tests/check_itinerary.mts (it is our own self-check, not an acceptance test) with a case:
  no process.env, config passed in the call -> itineraryUrl returned and alarm sends the SMS
  with the passed smsFrom/messagingProfileId.
- Update both READMEs and docs/design/DECISIONS.md (new row: why config travels with the call).
Run npm test, npm run check, npm run typecheck in services/session-actor and npm test +
npm run typecheck in services/mcp-server until green. Do not commit.

## 12. Docs sweep for steps 7-11

Read the code changes of steps 7-11 (`git diff a04dafd -- services assistant tests`) and update
every Markdown file that is now out of date. Keep each file's structure and tone; be factual.
- docs/design/DECISIONS.md: rows for the itinerary in Cloud Storage (UUID link as capability, served
  by the actor function because the runtime has no signed URLs), the alarm reminder (one alarm per
  actor, at-least-once, never throw), the shared actor binding (webhook stays on HTTP: Python
  cannot bind actors; metrics still over HTTP).
- docs/design/OBSERVABILITY.md: the new log events (itinerary_skipped, itinerary_write_failed,
  reminder_scheduled, alarm.sms_sent, alarm.failed, alarm.sms_config_missing,
  mcp.actor.http_fallback) and what each tells an on-call engineer.
- docs/guides/DEMO_SCRIPT.md: a demo beat - pick a flight, get the SMS with the itinerary link,
  open it, then receive the reminder text after REMINDER_DELAY_SECONDS.
- docs/guides/HOW_TO_CALL.md: what the caller receives (itinerary link, reminder text).
- docs/build/DOGFOODING.md: today's notes - two parallel `opencode run` processes sharing one
  XDG_DATA_HOME hang silently (fix: one data dir per process); a Kimi-K3 run hung and was replaced
  by GLM-5.2; the live bug that umbrella `[env_vars]` do not reach actor instances.
- tests/README.md: the new self-checks check_itinerary.mts and check_flow_capabilities.py.
- AGENTS.md "Platform facts (verified)": actor alarms API, `[storage.cloudstorage.<NAME>]`
  binding, shared actors (owner vs reference), `[env_vars]` not reaching actor instances.
- docs/README.md if it indexes files.
Attribution: steps 7-12 were built by OpenCode with Telnyx zai-org/GLM-5.2. Change no code.
- services/mcp-server/README.md (the flytlv client paragraph, around line 110) and the matching
  doc comment in services/mcp-server/src/flytlv.ts: reword so it is clear the API key is REQUIRED
  and sent on every request (`FLYTLV_API_KEY` Edge secret in the `X-API-Key` header; the server
  refuses to start without it). Then explain fail-closed as the failure case only: a wrong or
  missing key returns 404, which the client logs once as `flytlv.feed_off` ERROR. Comment-only
  change in flytlv.ts.
- services/mcp-server/func.toml comment: it says the actor's "own env still wins"; the code does
  `config.X ?? process.env.X`, so the value sent with the call wins. Fix the comment only.

## 13. Attribution: one honest sentence instead of many mentions

Today README.md, docs/design/DECISIONS.md (row 15) and docs/guides/DEMO_SCRIPT.md mention
"Claude Code" in many places. Consolidate, without making any claim false:
- README.md component table: replace the column holding "Claude Code" with one column
  "Built with OpenCode (Telnyx model)" that lists only what OpenCode really built: the first
  version of each component (models as already listed: GLM-5.2, Kimi-K3 for the webhook) and the
  steps 7-13 changes (GLM-5.2). The deploy pipeline row gets "—".
- README.md: delete the "Claude Code" sentence near the top (line ~12) and the "After the first
  deploy (Claude Code ...)" section (line ~570); put the facts they carried in ONE short section
  "Tool comparison" near the end: OpenCode + Telnyx models built the first version of every
  component and every change from 7 Oct 2026 (steps 7-13); the platform fixes and features between
  the first deploy (6 Oct 2026, 18:00 Israel time) and 7 Oct morning were made with another AI coding
  tool, Claude Code, for comparison, as the challenge allows. Keep the useful list of what those
  fixes were.
- DECISIONS.md row 15 and DEMO_SCRIPT.md line ~237: shorten to point at that README section.
- Use Israel time (Asia/Jerusalem) for any time you write.
Change no code.
