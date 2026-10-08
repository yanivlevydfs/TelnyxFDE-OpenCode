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

## 14. Path-test cleanup must never leave a copy behind

Live finding (7 Oct 2026): scripts/ops/workflow_paths.py left its throwaway assistant
"FlyTLV Travel Line (path test)" and its TeXML app on the account (created 01:42 Israel time);
they had to be deleted by hand. The `finally` block runs only if the process ends normally, and
one failing call (e.g. `retrieve`) skips the deletes after it.

Fix in scripts/ops/workflow_paths.py only (keep it short, use the Telnyx SDK):
1. Before creating the copy, sweep leftovers: list assistants, and for each whose name ends with
   " (path test)" delete its TeXML app (via `provision._extract_connection_id`) and the assistant.
   Never touch any other assistant. Log each removal (WARNING `path.leftover_removed`).
2. In `finally`, run each cleanup call in its own try/except: get the TeXML id, delete the
   assistant, delete the TeXML app. Log ERROR with traceback on failure and keep going.
3. Update scripts/README.md (one paragraph) and add a line to docs/build/DOGFOODING.md.
Do not run the script (it creates live resources). Check it compiles:
`.venv/Scripts/python -m py_compile scripts/ops/workflow_paths.py`, and keep
`.venv/Scripts/python -m pytest tests/test_assistant.py -q` green. Do not commit.

### 14b. README status table: phone number and test counts

In the README.md "Status" table:
- Phone number row: we HAVE the number. Show `+972765671113` (Israel), routed to TeXML app
  "FLYTLV ai-assistant" -> assistant `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16`; status:
  "bought and linked; Telnyx regulatory approval pending (requirement-info-pending)". Verified
  7 Oct 2026 via GET /v2/phone_numbers.
- Tests column, current counts: session-actor `7/7 + check 8/8`, assistant `7/7 + check 29/29`,
  MCP `11/11`, shared `13/13`, webhook `9/9`.
Make sure the README "Live endpoints and phone number" section shows the same number and status.
Change nothing else.

### 14c. Tool comparison: one sentence

In README.md, replace the whole "Tool comparison" section body (including the list "What ... shipped
in the 6 Oct 18:00 Israel -> 7 Oct morning window" and its bullets) with ONE sentence:
"OpenCode with Telnyx-hosted models built the first version of every component and every change
from 7 Oct 2026 (steps 7-14); the fixes and features between the first deploy (6 Oct 2026, 18:00
Israel time) and 7 Oct morning were made with another AI coding tool, for comparison, as the
challenge allows."
Make docs/design/DECISIONS.md row 15 and docs/guides/DEMO_SCRIPT.md say the same in one line each
(no tool name other than OpenCode). Change nothing else.

## 15. PRODUCT.md and INTEGRATION.md

Read README.md, docs/challenge/USE_CASE.md, docs/design/*, docs/guides/*, assistant/flow.py,
assistant/provision.py, and the code in services/. Write two NEW documents. Every fact must come
from the code or the existing docs; do not invent numbers, SLAs, prices, customers or roadmap
dates. Use Israel time for any time.

### docs/design/PRODUCT.md (audience: Telnyx reviewers and product people, non-engineers)
- One-paragraph pitch: FlyTLV Travel Line, cheap flights from Tel Aviv by phone.
- Who it is for and the problem it solves.
- The caller journey, step by step (greeting, returning-caller "welcome back", search, follow-ups,
  pick a flight, read-back and confirm, SMS with booking link + itinerary page, reminder text,
  transfer to a human, goodbye).
- Capabilities, grouped exactly as the step 9 list (flight search, travel patterns, conversation,
  actions, safety/accuracy).
- Safety and honesty rules (never invent prices/availability, never claim a booking; the caller
  books on flytlv.app; prices can change).
- What the caller receives (spoken deals, SMS, itinerary page, reminder).
- Which Telnyx products power it, in one table: AI Assistant + Conversation Workflow, Telnyx
  Inference (assistant model zai-org/GLM-5.3-Flash), MCP, Edge Functions, Stateful Actors (incl.
  alarms, shared actors), KV, Cloud Storage, Messaging, Voice number.
- Current status (live pieces; phone number +972765671113 bought, regulatory approval pending)
  and known limits (SMS to Israeli numbers only; one reminder per caller; prices from the
  flytlv.app feed).

### docs/guides/INTEGRATION.md (audience: engineers integrating with or operating the system)
- Architecture in one diagram (ASCII) and the request path of a call.
- Every integration point with exact contract, auth and failure behaviour:
  1. Telnyx Dynamic Variables webhook (signature check before JSON, 1.5 s budget, variables
     returned, backend_degraded defaults).
  2. MCP server: URL, bearer MCP_API_KEY, the 4 tools with their input schemas and outputs,
     conversation id from params._meta.telnyx_conversation_id.
  3. Session actor: shared actor binding (SESSIONS) and the HTTP facade
     `POST /actors/{digits}/{method}` (bearer INTERNAL_API_TOKEN, method allowlist, error codes),
     `POST /metrics/*`, public `GET /itineraries/<uuid>.html`.
  4. flytlv.app deals API: `GET {FLYTLV_API_BASE}/api/private/deals`, REQUIRED `X-API-Key`
     header (FLYTLV_API_KEY Edge secret), params, response fields, 404 = wrong key (fail-closed).
  5. Telnyx KV keys (session/<conversation_id>, cache/deals/<query>, flags), Cloud Storage bucket
     flytlv-itineraries, Messaging (SMS_FROM, MESSAGING_PROFILE_ID), actor alarm reminder.
- Configuration reference: every env var and Edge secret per service, from func.toml /
  telnyx.toml / code, with where it is read (note: umbrella [env_vars] do not reach actors; the
  MCP server forwards actor config with saveDeal).
- Deploy (GitHub Actions ship.yml) and provisioning (assistant/provision.py, --dry-run).
- How to test: unit tests, self-checks, scripts/ops/live_check.py, workflow_paths.py.
- Troubleshooting table: symptom -> log event -> fix (from docs/design/OBSERVABILITY.md).

Also add both files to docs/README.md and link them from README.md. Change no code.

### 15b. README links every Markdown file

Add (or replace) a "Documentation" section near the top of README.md with a table linking EVERY
Markdown file in the repo (`git ls-files "*.md"` plus the two step-15 files; skip node_modules
and reference/), grouped by area (overview, challenge, design, guides, build, services, assistant,
shared, scripts, tests, AGENTS.md), each with a one-line purpose taken from the file itself.
Use relative links. Make sure every link resolves. Change nothing else.

### 15c. Fix the fact-check findings in PRODUCT.md and INTEGRATION.md

A read-only fact check against the code found 23 wrong or overstated claims; the list with file:line
evidence is in logs/factcheck-step15.md. Fix each one in docs/design/PRODUCT.md and
docs/guides/INTEGRATION.md (and the same wording in services/mcp-server/README.md if it repeats
item 4). Verify each fix against the cited code. Change no code.

## 16. Add ruff to requirements-dev.txt

The repo was cleaned of Ruff errors (commit a04dafd) but `ruff` is not in requirements-dev.txt,
so `python -m ruff check .` fails with "No module named ruff". Add a pinned `ruff==<latest>` line
under a new "# --- lint ---" group with a short comment, install it
(`uv pip install --python .venv/Scripts/python.exe -r requirements-dev.txt`), run
`.venv/Scripts/python -m ruff check .` and fix any NEW Ruff errors in our Python files (not in
.venv, node_modules or reference/). Mention `ruff check .` in the README setup/test commands.
Keep all Python tests green. Do not commit.

## 17. Pin telnyx-edge v0.5.10

telnyx-edge v0.5.10 is out (release notes: `actors logs --tail` streams live, `ship` waits 30m,
`dev` rejects what `ship` would, `[network.<name>]` validated at ship time). Locally it is
installed and every test, self-check and live script passes with it. Change
`TELNYX_EDGE_VERSION: v0.5.9` to `v0.5.10` in .github/workflows/ship.yml (line 25), and the two
places that say which version CI installs: README.md line 506 and docs/guides/INTEGRATION.md
line 427. Keep every mention of the Windows backslash bug as "v0.5.9" (ship.yml line 3,
README.md line 422, DECISIONS.md decision 17, INTEGRATION.md line 416): that is what was
observed on that version. Change nothing else. Do not commit.

## 18. Presentation for demo day (walkthrough part)

Write docs/guides/PRESENTATION.md: the slide text for the 7-10 minute "Live Walkthrough &
Decision Review" in docs/challenge/code_challenge.md (Demo Day, part 2). The audience is the
Telnyx FDE team. The live demo itself follows docs/guides/DEMO_SCRIPT.md and is not in this deck.

Take every fact from the repo (README.md, docs/design/*, docs/build/DOGFOODING.md,
docs/build/PROMPTS.md, assistant/flow.py, services/*, shared/common.py, scripts/ops/*).
Invent nothing: no numbers, costs, model names or bug details that the repo does not state.
If a fact is missing, write `TODO(Yaniv): <what is missing>` instead of guessing.

11-13 slides, in this order, each answering one question the brief asks:
1. Title: FlyTLV Travel Line, one-line pitch, the phone number and live URLs.
2. Why this use case: the real problem and who calls.
3. Architecture: Caller -> Assistant -> Workflow -> Edge Function (webhook) -> KV / Actor -> MCP.
   Give it as a mermaid `flowchart LR` block, using only the components that exist.
4. Conversation Workflow: the nodes (speak vs prompt vs tool) and why each is that type.
5. Edges: which are LLM conditions and which are expression edges (variable comparisons), and why.
6. MCP server: the 4 tools, which node may call which tool, how it is built (SDK, stateless).
7. Dynamic Webhook Variables: what the webhook returns and how those values change routing
   and the greeting; the 1.5 s budget and backend_degraded fallback.
8. Actor vs KV vs plain function logic: a table, one row per piece of state, with the reason.
9. Stretch goals done (alarms, Cloud Storage, KV flags, shared actors, tracing, etc.), only
   those the code really has.
10. Observability: what is logged, the metrics signal, and "how I know within a minute it broke".
11. The hardest bug: symptom -> signal that found it -> root cause -> fix -> evidence.
12. Building with Telnyx Inference via OpenCode: models used, what worked, what did not.
13. Tradeoffs and what I would do next.

Format each slide as:
`## Slide N - <title>` then 3-5 bullets of at most 14 words each, then
`Notes:` with 2-4 sentences the speaker says. Plain English, no marketing words.
End with a "Sources" list of the files used per slide. Add the file to docs/README.md and
the README Documentation table. Change no code. Do not commit.

## 19. One folder for the demo-day presentation

Keep everything for demo day in docs/presentation/. The rendered slide deck's source is already
there in docs/presentation/deck/ (deck.json + slides/*.html, laid out by Claude Code from
PRESENTATION.md; leave those files unchanged). Then:
- `git mv docs/guides/PRESENTATION.md docs/presentation/PRESENTATION.md` and
  `git mv docs/guides/DEMO_SCRIPT.md docs/presentation/DEMO_SCRIPT.md`.
- Fix every link to either file across the repo (`git grep -n "PRESENTATION.md\|DEMO_SCRIPT.md"`),
  including relative links inside the two moved files, so every link resolves.
- Write docs/presentation/README.md: what each file is (slide text, demo script, deck source),
  that the live deck is https://claude.ai/artifact/3R5GZNrRkjn3ZEKL4Vtc3t (private until shared,
  downloads as .pptx or PDF), and that deck/ was laid out by Claude Code while PRESENTATION.md
  was written by OpenCode (step 18).
- Update the structure tree in AGENTS.md, docs/README.md and the README Documentation table.
Change no code. Do not commit.

## 20. Caller history and audit trail

Goal: answer "what did this caller look for (destinations, dates, flights) and when?" for history
and for auditing. Three layers; keep each small, reuse existing helpers, follow AGENTS.md rules
(env-driven values, JSON logs, error handling, no hardcoding). Do not run provisioning or ship.

1. Telnyx conversation insights (assistant/provision.py). Verified live on 2026-10-08: Telnyx keeps
   every assistant conversation (`client.ai.conversations.list/retrieve`, messages via
   `client.ai.conversations.messages.list(id)`, metadata has `telnyx_end_user_target` = caller and
   `telnyx_conversation_id`); the assistant's `insight_settings.insight_group_id` points at the
   "Default" group, which only has a "Summary" insight. In provision.py, create (or reuse by name)
   an insight group "FlyTLV caller intent" with insights for: destinations asked about, travel
   dates / trip type, deal saved (destination + price) and call outcome; set it in
   `assistant_body()` as `insight_settings`. Use the Telnyx SDK (`client.ai.conversations.insight_groups`,
   `client.ai.conversations.insights`); check the SDK signatures in .venv before writing. Group name
   from env with that default. Keep `--dry-run` working and tests/test_assistant.py green.

2. Per-caller search history in the CallerSession actor (services/session-actor). `setLastResults`
   gets an optional `query` ({destination, country, category, trip_type, direct_only, dates, ...}
   exactly as search_deals received them) and `conversationId`; the actor appends
   `{ts, conversationId, query, resultCount, topDealIds (max 3)}` to `searchHistory`, capped by
   SEARCH_HISTORY_MAX (default 50, oldest dropped). Saves already exist in savedDeals; also append a
   `{ts, conversationId, type:"save", dealId}` entry. New read method `getHistory()` on the actor and
   the HTTP facade (same auth as the other routes). The MCP server passes `query` and the
   conversation id on its existing setLastResults call.

3. Audit trail in Cloud Storage. In the same actor calls, write one immutable JSON object per event
   to the existing bucket binding under `audit/<YYYY-MM-DD>/<conversationId>/<ts>-<type>.json`
   (prefix from env AUDIT_PREFIX, default "audit/"). The object holds the event plus a masked caller
   (reuse the existing masking helper; never the full number). A failed audit write logs ERROR with
   the stack and never fails the tool call. Keep `alarm()` untouched.

4. scripts/ops/history.py: read-only report for one caller (`--caller +972...`) or one date: Telnyx
   conversations for that caller (filter on `telnyx_end_user_target`), their insights when present,
   and the actor's `getHistory`. JSON log lines through shared/common.py like the other ops scripts.

Tests: add tests/check_history.mts (actor: history append + cap, save entry, audit object written
with masked caller, audit failure does not fail the call, getHistory route) and an `npm run check`
entry if convenient; add a provision dry-run assertion for insight_settings only if it fits
test_assistant.py without editing existing tests (else a new tests/check_insights.py). Run every
test and self-check listed in tests/README.md and keep them all green. Update READMEs
(session-actor, mcp-server, scripts, assistant) and docs/design/DECISIONS.md with one decision row
("history in the actor, audit in Cloud Storage, insights in Telnyx; not KV"). Do not commit.

## 21. Every setting lives in the environment

Owner rule 3 ("nothing hardcoded") audit, 2026-10-08. Code reads these variables but they are not
declared in .env.example, any func.toml [env_vars] or services/session-actor/telnyx.toml:
ASSISTANT_PHONE_NUMBER AUDIT_PREFIX DEALS_BROAD_FETCH_LIMIT FLAGS_CACHE_SECS FLYTLV_FLIGHTS_PATH
HANGUP_TOOL_ID HANGUP_TOOL_NAME INSIGHT_GROUP_ID INSIGHT_GROUP_NAME MAX_SAVED_DEALS PORT
SEARCH_HISTORY_MAX. Do NOT read or print .env (it holds secrets); work from .env.example.

1. .env.example lists EVERY environment variable any Python or TypeScript file in this repo reads
   (services, shared, assistant, scripts), grouped by component, each with its current default
   value (or empty for secrets) and a one-line comment. Secrets are marked "secret: set with
   telnyx-edge secrets add" and never get a value.
2. Each service's own config declares the non-secret variables it reads: services/webhook/func.toml
   and services/mcp-server/func.toml [env_vars], services/session-actor/telnyx.toml (keep the
   existing comment that actor instances do not see umbrella env_vars). Same defaults as the code.
3. Local runs load .env automatically: add one small helper in shared/common.py that reads the
   repo-root .env (KEY=VALUE lines, # comments, optional quotes) into os.environ WITHOUT
   overriding variables already set, and call it at the start of every scripts/ops/*.py and
   assistant/provision.py. Never call it on Telnyx Edge (the webhook must not use it).
4. Guard: add tests/check_env.py (pytest) that scans the repo's .py and .ts sources (not .venv,
   node_modules, reference/) for environment variable reads and fails, naming the variable,
   when one is missing from .env.example. List it in tests/README.md.
5. Prompt and speak-node text, tool names, storage key names and regexes are code/content, not
   settings: leave them in code.

Keep every test and self-check in tests/README.md green, ruff clean, typechecks clean. Update
README setup notes (".env is loaded automatically by local scripts"). Do not commit.

### 21b. Fix: PORT must not be in func.toml

Review of step 21: services/mcp-server/func.toml now sets `PORT = "8080"` with a comment saying it
has no effect on Edge. That is wrong: src/index.ts always listens on `process.env.PORT`, and Edge
starts it with `npm start` and injects its own PORT, so a declared PORT could override it and break
the live MCP server. Remove PORT (and its comment) from services/mcp-server/func.toml. Keep PORT in
.env.example, commented as "local npm start only; Telnyx Edge injects its own; never declare it in
func.toml". Make tests/check_env.py still pass. Change nothing else. Do not commit.

## 22. Never more than 5 files in Cloud Storage: overwrite, never grow

Hard account limit (owner, 2026-10-08): the flytlv-itineraries bucket may hold at most 5 objects,
and the limit cannot be raised. Over the limit every put fails with
`HTTP 400: TooManyObjects: You have exceeded the number of objects allowed for this bucket.`
(seen live: `itinerary_write_failed`, `audit_write_failed`). Today the actor writes a new
`itineraries/<uuid>.html` per caller+deal and one audit object per event, so the bucket fills up.
Rule: the code only ever writes to a FIXED set of at most 5 keys and overwrites them.

1. Itineraries: ITINERARY_SLOTS (default 4) fixed keys `itineraries/slot-<n>.html`. A caller always
   maps to the same slot: n = a stable hash of the caller entity id modulo ITINERARY_SLOTS. Each
   write overwrites that slot. Every write gets a fresh random token; the page's public link
   becomes `/itineraries/<token>.html`; the facade needs to find the slot from the token, so store
   `itin/<token>` -> slot number in the bucket object's own content? No: keep it simple and safe:
   the link is `/itineraries/<slot>-<token>.html`, the HTML object stores its token (e.g. in a
   leading `<!-- token:... -->` line or object metadata), and the facade serves the slot ONLY when
   the token matches; otherwise 404. So an old link whose slot was overwritten by another caller
   returns 404 and never shows someone else's trip. Validate `<slot>` (0..SLOTS-1) and `<token>`
   (strict UUID regex) as today. Remove the per-deal itineraryKeys map.
2. Audit: ONE object, `audit/latest.json`, overwritten. Add a singleton AuditLog Stateful Actor
   (one instance, like MetricsCounter; same telnyx.toml pattern, shared-actor binding if the
   MCP/actor side needs it) that keeps the last AUDIT_MAX_EVENTS (default 200) events in its own
   storage (single-threaded, no lost events) and overwrites `audit/latest.json` after each append.
   CallerSession sends its events (masked caller, never the full number) to AuditLog instead of
   writing objects itself. AUDIT_ENABLED (default "true") turns it off. A failed audit write logs
   ERROR with the stack and never fails the tool call. Total keys: 4 slots + 1 audit = 5.
3. Guard: add a constant check (unit test) that ITINERARY_SLOTS + 1 <= STORAGE_MAX_OBJECTS
   (default 5), and refuse at startup (log ERROR, clamp slots) if config breaks it.
4. scripts/ops/live_check.py: use ONE fixed test caller (LIVE_CHECK_CALLER, default a documented
   fake number) so runs reuse the same slot; add checks that a save returns an itineraryUrl, that
   GET on it returns 200, and that a made-up token on the same slot returns 404.
5. Add scripts/ops/storage_check.py (read-only): list the bucket over the S3 API with the
   TELNYX_API_KEY (sigv4, region from env) and fail if it holds more than STORAGE_MAX_OBJECTS or
   any key outside the allowed set.
6. Tests: update tests/check_itinerary.mts and tests/check_history.mts for slots, token match,
   404 on mismatch, audit single object, AUDIT_ENABLED off. Declare every new variable in
   .env.example and the toml files (check_env green). Document the limit and its log signature in
   docs/design/DECISIONS.md, OBSERVABILITY.md and services/session-actor/README.md.

Keep every test and self-check in tests/README.md green, ruff and typechecks clean. Do not commit.

### 22b. Fixes from the live run of step 22

Live run after deploy (2026-10-08 18:57 UTC): writes now go to `itineraries/slot-1.html` and
`audit/latest.json` (good), but:
1. `GET itinerary URL returns 200` fails with 404. Cause: every saveDeal mints a NEW token, so the
   same caller's second save overwrites their slot with a new token and the link from the first
   save (already sent by SMS) dies. Fix: one token per caller, minted on the first save, stored in
   the CallerSession actor's storage and reused on every later save; the slot file is overwritten
   with the same token. A link only dies when a DIFFERENT caller takes the same slot. Update
   tests/check_itinerary.mts: two saves by one caller keep the same URL and both GETs return 200;
   another caller hashing to the same slot makes the first caller's link 404.
2. scripts/ops/storage_check.py exits with "Set STORAGE_S3_ACCESS_KEY and STORAGE_S3_SECRET_KEY".
   Use TELNYX_API_KEY as both access key and secret by default (verified live: sigv4 with the API
   key lists the bucket); keep the two STORAGE_S3_* variables as optional overrides in .env.example.
Keep every test and self-check in tests/README.md green, ruff and typechecks clean. Do not commit.

### 22c. storage_check endpoint

storage_check.py gets `S3 ListObjectsV2 returned 301` because the default STORAGE_S3_ENDPOINT
`https://telnyxcloudstorage.com` is not regional. Verified live: `https://us-central-1.telnyxcloudstorage.com`
works. Default the endpoint to `https://{STORAGE_S3_REGION}.telnyxcloudstorage.com` when
STORAGE_S3_ENDPOINT is empty, and set the .env.example line to empty with that comment.
Change nothing else. Keep check_env green. Do not commit.
