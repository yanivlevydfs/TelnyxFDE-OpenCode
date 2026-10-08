# assistant — FlyTLV Travel Line assistant definition & provisioning

Not an Edge service. This component builds the Telnyx AI Assistant definition
(conversation workflow, tools, dynamic-variable defaults) and provides a small
CLI that provisions it through the official `telnyx` Python SDK.

## Files

- `flow.py` — pure data: the `conversation_flow` graph (`build_flow`), a static
  `validate`, the assistant-level `tools` (`build_tools`) and `DEFAULT_VARIABLES`.
  No network, no env reads →确定性可测.
- `provision.py` — `assistant_body(env, mcp_id)` builds the create-assistant body
  from env vars + `flow`; the `provision()` coroutine and `main()` CLI create the
  integration secret, MCP server, assistant and link a phone number via the SDK.

## Capabilities (step 9 upgrade)

The workflow and assistant instructions together cover the full capability list
from `docs/build/PROMPTS.md` step 9. Each capability is realised by a node, an
edge or an instruction line; the dedicated self-check
`tests/check_flow_capabilities.py` asserts every one of them.

| Capability | Covered by |
| --- | --- |
| Search from TLV | base + `search_flights` prompt ("flights from Tel Aviv (TLV)") |
| Named destination | `search_flights` instructions (`destination` IATA, e.g. `ATH`) |
| Global discovery ("anywhere cheap") | `search_flights` instructions ("no destination and no country", "search everywhere") |
| One-way and round trip | `trip_type='one_way'` mapping in `search_flights` |
| Direct and connecting | `direct_only` and `max_layover_hours` mappings |
| Cheapest first | default `sort='cheapest'` mapping |
| Flexible dates and date ranges | `departure_date` YYYY-MM-DD list mapping |
| Travel patterns (mid-week, weekend, long weekend, short break, 4–5 day, 7-day, flexible) | "Travel patterns" paragraph in `search_flights` instructions, each mapped only to args the `search_deals` tool really accepts (see table below) |
| Natural follow-ups | "Keep context for the whole call" paragraph in `search_flights` |
| Refine preferences | same paragraph ("refine the search when the caller changes mind") |
| Compare prices & destinations | same paragraph ("compare prices and destinations when the caller asks which is cheaper") |
| Offer alternatives when nothing matches | same paragraph ("offer alternative destinations or dates when the first search returns nothing") |
| Give the booking link | `save_deal`/`search_flights` instructions ("booking link is the deal_url returned by the tool") |
| Send by SMS | `save_deal` instructions call `send_deal_sms` only when `{{flag_sms_enabled}}` is `true`, after a read-back + yes |
| Transfer to a human | `transfer_call` prompt node + the inline `transfer` tool (`build_tools` when a `TRANSFER_TO_NUMBER` is set) |
| End the call | `hangup_call` tool node + the inline `hangup` tool (always present) |
| Never invent availability or prices | base + `search_flights` instructions ("never invent ... every detail you mention must come from the tool result") |
| Never claim a booking was completed | base + `search_flights`/`save_deal` instructions ("'I found a flight', never 'you are booked'") |
| Prices can change until booked | base + `search_flights`/`save_deal` instructions ("deals come from the live feed and prices can change") |
| Read back + confirm before sending link | `search_flights` and `save_deal` instructions ("read back the chosen deal: destination, dates, price with currency, and direct vs connecting ... only call save_deal (or send_deal_sms) after a clear yes") |

### Travel patterns → `search_deals` arguments

Each pattern maps only to arguments the tool actually accepts in
`services/mcp-server/src/server.ts` (`search_deals` zod schema). Days ↔ nights:
a *N-day trip* is *N-1 nights* (you fly home on the last day).

| Pattern | Mapping | Notes |
| --- | --- | --- |
| mid-week | `category='Midweek Saver'` or `departure_weekday='Tuesday'`/`'Wednesday'` | flytlv exposes a mid-week saver category; the weekday filter is the explicit alternative |
| weekend | `category='Weekend'` and `weekend='upcoming'` when the caller means this/next weekend | the server computes weekend dates |
| long weekend | `min_nights=3, max_nights=3` + `weekend='upcoming'` (Thu–Sun / Fri–Mon style) | 3 nights |
| short break | `min_nights=2, max_nights=2` (or `category='Quick Visit'`) | 2-night trips |
| 4–5 day trip | `min_nights=3, max_nights=4` | 4 days = 3 nights, 5 days = 4 nights |
| 7-day trip | `min_nights=6, max_nights=6` (or `category='Weekly'`) | 7 days = 6 nights |
| flexible | omit `departure_date`/`departure_weekday`/`weekend`; use `sort='cheapest'` | express absence, not a fake arg |

## MCP gaps

None: every capability from step 9 maps to an existing `search_deals`
argument (the ones zod accepts in `services/mcp-server/src/server.ts` —
`trip_type`, `destination`, `country`, `category`, `weekend`, `departure_date`,
`departure_weekday`, `min_nights`, `max_nights`, `max_price`, `min_discount_pct`,
`direct_only`, `max_layover_hours`, `time_of_day`, `sort`) or is an
instruction-level capacity (natural follow-ups, comparisons, alternatives,
read-back confirmation, "I found a flight" framing, prices-can-change disclaimer).
`flexible` is expressed as the *absence* of date constraints, not a fictional
argument. No instruction in `flow.py` references a `search_deals` argument that
the tool does not expose; `tests/check_flow_capabilities.py::test_travel_patterns_map_to_real_args`
keeps that invariant.

## Conversation workflow

```
greeting (speak — verbatim disclosure)
  └─ default ─→ identify_intent (prompt — routing hub)
                  ├─ expression  backend_degraded == "true"            → degraded_notice (speak) → farewell
                  ├─ expression  flag_deals_enabled == "false"         → deals_disabled (speak)  → farewell
                  ├─ expression  telnyx_conversation_duration_secs >= N → timeout_escalate (prompt)
                  │                                                         ├─ llm accepts  → transfer_call
                  │                                                         └─ llm declines → farewell
                  ├─ llm "search flights"      → search_flights ─┬─→ save_deal
                  │                                              └─→ identify_intent
                  ├─ llm "save a deal"         → save_deal      ──→ identify_intent
                  ├─ llm "list saved deals"    → list_saved     ──→ identify_intent
                  ├─ llm "general question"    → answer_faq     ─┬─→ search_flights
                  │                                              └─→ identify_intent
                  ├─ llm "speak to a human"    → transfer_call  ──→ farewell
                  └─ llm "caller is finished"  → farewell (speak) → hangup_call (tool node: shared hangup tool)
   (search_flights, save_deal, list_saved and answer_faq also have a
    "caller is finished" edge to farewell)
```

- **12 nodes, 26 edges.** **speak nodes** = `greeting`, `degraded_notice`, `deals_disabled`, `farewell` —
  each has its single required `default` edge (verbatim delivery, no model turn).
- **prompt nodes** = the LLM-driven steps; they carry step instructions that
  `append` to the assistant base instructions (two tightly-scoped steps `replace`).
- **expression edges** use exactly the variables the dynamic-variables webhook
  supplies (`flag_deals_enabled`, `backend_degraded`) plus the Telnyx system
  variable `telnyx_conversation_duration_secs` for the timeout-escalation
  stretch goal. Deterministic facts are evaluated before the model turn
  (design decision #12).
- **llm edges** route on detected intent.

`validate()` returns a list of structural problems (start node exists, edge
targets exist, valid condition types, every speak node has one default edge).
Empty list = a valid graph.

## Dynamic variables

`flow.DEFAULT_VARIABLES` are the safe defaults declared on the assistant; the
webhook (`fde-webhook`) overrides them at call start. If the webhook fails
entirely the defaults keep the expression edges from comparing against raw
`{{placeholders}}`:

| Variable | Default | Used by |
| --- | --- | --- |
| `caller_known` | `false` | identify_intent prompt (welcome-back) |
| `call_count` | `0` | — |
| `saved_count` | `0` | — |
| `last_saved_deal` | `` | identify_intent prompt (welcome-back) |
| `backend_degraded` | `false` | expression edge → degraded_notice |
| `flag_deals_enabled` | `true` | expression edge → deals_disabled |

## Provisioning (`provision.py`)

Every URL, id, model and voice comes from env vars / Telnyx Edge secrets —
nothing is hardcoded. The CLI runs five steps in order:

1. **integration secret** — stores `MCP_API_KEY` (`/v2/integration_secrets`).
2. **MCP server** — `/ai/mcp_servers` pointing at the deployed MCP Edge Function,
   authenticated with the secret as `api_key_ref`.
3. **conversation insight group** — `/ai/conversations/insight-groups` creates
   (or reuses by name) the "FlyTLV caller intent" group with four insights
   (destinations, dates/trip type, deal saved, call outcome) and assigns each
   insight to the group. Re-runnable: existing groups/insights are reused by
   name, and an insight already assigned is left as-is.
4. **assistant** — `/ai/assistants` with the workflow, dynamic-variables
   webhook (8 s timeout, Telnyx's guidance for Edge cold starts), MCP server
   reference, the inline `transfer` tool, and `insight_settings` pointing at
   the group from step 3. Ending the call is a terminal **tool node** running
   the shared hangup tool (`HANGUP_TOOL_ID`, created on first run), so no
   prompt node can hang up mid-conversation.
5. **phone number** — links an owned number to the assistant's voice connection.

`--dry-run` skips all API calls and prints the assistant body that *would* be
created (used by the unit test).

### Required env vars

| Var | Used for |
| --- | --- |
| `TELNYX_API_KEY` | SDK auth (injected by the `[telnyx]` Edge binding) |
| `ASSISTANT_MODEL` | assistant `model` (Telnyx-hosted model id) |
| `ASSISTANT_VOICE` | assistant `voice_settings.voice` |
| `WEBHOOK_URL` | `dynamic_variables_webhook_url` (the `fde-webhook` Edge Function URL) |
| `MCP_URL` | the `fde-mcp` Edge Function URL, registered as an MCP server |
| `MCP_API_KEY` | bearer token stored as an integration secret for the MCP server |

### Optional env vars

| Var | Default | Used for |
| --- | --- | --- |
| `ASSISTANT_NAME` | `FlyTLV Travel Line` | assistant name |
| `ASSISTANT_DESCRIPTION` | … | assistant description |
| `ASSISTANT_PHONE_NUMBER` | `` | transfer `from` (caller-id of transferred leg) |
| `TRANSFER_TO_NUMBER` | `` | transfer `to` (human agent); empty ⇒ no transfer tool |
| `TRANSFER_TO_NAME` | `` | the human's name the assistant offers (e.g. Ofek) |
| `HANGUP_TOOL_ID` | `` | shared hangup tool for the End Call tool node; created if empty |
| `ASSISTANT_ID` | `` | update this assistant instead of creating one |
| `MCP_SERVER_ID` | `` | reuse this registered MCP server |
| `ASSISTANT_PHONE_NUMBER_ID` | `` | number id to link to the assistant (step 4) |
| `ASSISTANT_CONNECTION_ID` | `` | voice connection id for the link (else read from the assistant record) |
| `MCP_API_KEY_REF` | `flytlv-mcp-key` | integration secret identifier |
| `MCP_SERVER_NAME` | `flytlv-mcp` | MCP server name |
| `WEBHOOK_TIMEOUT_MS` | `8000` | dynamic-variables webhook timeout |
| `CONVERSATION_TIMEOUT_SECS` | `600` | the duration comparison for the escalation edge |
| `INSIGHT_GROUP_NAME` | `FlyTLV caller intent` | the conversation insight group name (created/reused by name) |
| `INSIGHT_GROUP_ID` | `` | skip step 3 and wire this group id directly (else created) |

### Run

```bash
# Dry run — print the body, no API calls:
python assistant/provision.py --dry-run

# Provision for real (env vars filled in):
TELNYX_API_KEY=... ASSISTANT_MODEL=telnyx/zai-org/GLM-5.3 \
ASSISTANT_VOICE=Telnyx.KokoroTTS.af_heart \
WEBHOOK_URL=https://fde-webhook-<id>.telnyxcompute.com \
MCP_URL=https://fde-mcp-<id>.telnyxcompute.com MCP_API_KEY=... \
python assistant/provision.py
```

## Test

```bash
.venv/Scripts/python -m pytest tests/test_assistant.py -q   # this component
.venv/Scripts/python -m pytest tests -q                     # everything
```

## Observability

`provision.py` logs each step as structured JSON via `shared/common.py`
(`provision.integration_secret`, `provision.mcp_server`, `provision.insight_group_*`,
`provision.insight_*`, `provision.assistant`, `provision.phone_linked` /
`provision.phone_link_manual`). The phone-number link is the one soft step: if
Telnyx does not expose a connection id for the assistant the number is left
unlinked with a warning rather than aborting an otherwise-complete assistant.

## Conversation insights (step 20)

Telnyx keeps every assistant conversation and runs "insights" (LLM summaries
derived from the transcript) automatically for ones whose assistant points at
an insight group. Provisioning creates the "FlyTLV caller intent" group
(`INSIGHT_GROUP_NAME`, default) with four insights — all stable identifiers
reused by name on re-runs:

| Insight (`_insight_definitions`) | Extracts |
| --- | --- |
| `flytlv_destinations` | the destination(s) the caller asked about |
| `flytlv_dates_triptype` | travel dates and trip type (one_way / round_trip) |
| `flytlv_deal_saved` | whether a deal was saved, with destination + price |
| `flytlv_call_outcome` | one-phrase call outcome ("deal saved", "searched no save", …) |

The group id is wired into `assistant_body().insight_settings.insight_group_id`
and read back by `scripts/ops/history.py` via
`client.ai.conversations.retrieve_conversations_insights(id)`. `--dry-run` emits
the body with `insight_settings` (empty `insight_group_id` by default, or
`INSIGHT_GROUP_ID` when set).
