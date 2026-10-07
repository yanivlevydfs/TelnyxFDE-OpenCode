# FlyTLV Travel Line — product brief

Audience: Telnyx reviewers and product people. This is what the product is, who
it is for, what a call feels like, what it can and cannot do, what the caller
gets back, and which Telnyx products underpin it. The engineering contracts are
in [docs/guides/INTEGRATION.md](../guides/INTEGRATION.md); the design rationale
is in [docs/design/ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/design/DECISIONS.md](DECISIONS.md).

## Pitch

FlyTLV Travel Line is a phone line for cheap flights from Tel Aviv. A caller
phones one number, asks in plain English for what they want ("something cheap
to Cyprus in November", "a weekend trip to Greece", "the biggest discount to
anywhere"), hears the 2–3 cheapest deals from the live `flytlv.app` feed read
out with full flight details, can save a deal and have its booking link texted
to them, and is remembered on the next call ("Welcome back, last time you
saved Larnaca for 64 dollars"). Everything runs on Telnyx; the caller only
needs a phone.

## Who it is for and the problem it solves

People in Israel who are looking for cheap flights from Tel Aviv (round trip
or one way) and would rather ask a quick phone call than search across
websites. Flight prices from Tel Aviv change often, so finding the cheapest
deal means a lot of searching; FlyTLV reads the live `flytlv.app` deals feed
and speaks the best results back. See [docs/challenge/USE_CASE.md](../challenge/USE_CASE.md).

## The caller journey, step by step

1. **Greeting.** The caller dials **+972 76-567-1113** and hears the verbatim
   brand greeting and AI disclosure ("Welcome to the FlyTLV Travel Line. I'm
   an AI assistant. I can find you cheap flights from Tel Aviv, round trip or
   one way, and remember the ones you save. This call may be recorded for
   quality."). This line is delivered word-for-word, with no model turn, so the
   compliance wording is exact.
2. **Welcome back.** If the caller has phoned before and saved a deal, the
   assistant continues "Welcome back, last time you saved {{last_saved_deal}}"
   and offers to re-check today's prices to that place or read their saved
   deals. The greeting's per-caller facts (call count, saved count, last saved
   deal) are fetched from the per-caller Stateful Actor at call start by the
   dynamic-variables webhook — the caller does nothing extra.
3. **Search.** The caller asks in their own words ("something cheap to Cyprus
   in November", "any deals for Hanukkah", "a weekend trip", "the cheapest
   anywhere"). The assistant routes the request through the Conversation
   Workflow's `search_flights` node, which calls the `search_deals` MCP tool
   against the live `flytlv.app` feed (KV-cached for a few minutes) and reads
   back the top 2–3 deals.
4. **Follow-up questions.** The caller can refine the search mid-call ("under
   100 dollars", "next weekend", "direct only", "what about Greece?") without
   restarting; the assistant keeps context for the whole call, compares prices
   and destinations when asked, and offers alternatives when nothing matches.
5. **Pick a flight.** The caller says "Save the first one" (or names the
   city). The assistant only saves a deal it actually read out — the deals
   spoken are stored on the caller's actor, so the model cannot invent a
   price or a link.
6. **Read-back and confirm.** Before sending any link, the assistant reads
   back the chosen deal's destination, dates, price with currency and
   whether it is direct or connecting, and asks for a clear yes.
7. **SMS with the booking link.** After a "yes", the assistant can text the
   deal and its booking link to the number the caller is calling from, from
   the sender "FlyTLV". Texts go only to the caller's own number and only for
   a deal they were offered. The caller books themselves on `flytlv.app`
   through that link — FlyTLV never books or takes payment.
8. **Itinerary page.** When a deal is saved, the actor writes a short
   **itinerary link** — a small mobile-friendly web page on Telnyx Cloud
   Storage with the destination, dates, airline, direct vs stops, price and
   a "Book this flight" button. The link is returned in the `save_deal` tool
   result and appended to the SMS as `Itinerary: <url>`; the caller opens it
   from the text rather than hearing the URL read aloud (the assistant is not
   told to read it back). It holds a long random UUID (no password);
   re-saving the same deal reuses the same page.
9. **Reminder text.** About `REMINDER_DELAY_SECONDS` (default 10 minutes)
   after the save, the assistant sends a short follow-up text — "Still
   thinking about Larnaca for 64 USD? Your itinerary: <url>" — to the number
   the caller phoned from. One reminder per save; a newer save replaces an
   earlier pending reminder.
10. **Transfer to a human.** If the caller asks for a person, the assistant
    offers to transfer them to a human agent (named "Ofek" when configured)
    using the inline `transfer` tool, and the call hands off.
11. **Goodbye.** The caller can end with "That's all, thanks". The assistant
    speaks the verbatim farewell ("Thanks for calling FlyTLV. Goodbye.") and
    ends the call deterministically with a terminal hangup tool node — no
    model turn, so the model cannot hang up mid-conversation.

## Capabilities

Grouped exactly as the step 9 capability list (the self-check
`tests/check_flow_capabilities.py` asserts each is covered by a node, an edge
or an instruction line in `assistant/flow.py`).

### Flight search

- From Tel Aviv (TLV) only.
- A named destination (IATA code, e.g. "Athens" → `ATH`).
- Global discovery ("anywhere cheap" — no destination, no country).
- Round trip (default) and one way.
- Direct and connecting flights.
- Cheapest first (the default sort), plus best-value, biggest-discount,
  soonest and fastest.
- Flexible dates and date ranges (a single date or a comma-separated list).

### Travel patterns

Each maps to concrete `search_deals` arguments the tool actually exposes, and
never to a fabricated argument: mid-week, weekend, long weekend, short break,
4–5 day trip, 7-day trip, flexible. See the mapping table in
[assistant/README.md](../../assistant/README.md) ("Travel patterns →
search_deals arguments").

### Conversation

- Natural follow-up questions, with context kept for the whole call.
- Refine preferences (different destination, more nights, another date,
  direct vs connecting).
- Compare prices and destinations ("which is cheaper?", "where can I go?").
- Offer alternative destinations or dates when the first search returns
  nothing or the caller is not happy with the results.

### Actions

- Give the booking link (the `deal_url` returned by the tool).
- Send the link by SMS with `send_deal_sms` — only when the KV feature flag
  `sms_enabled` is on, and only after a read-back and a clear yes.
- Transfer the call to a human agent.
- End the call.

### Safety / accuracy

- Never invent availability or prices — every detail spoken must come from
  the tool result.
- Never claim a booking was completed — the assistant says "I found a
  flight", never "you are booked"; the caller books themselves on
  `flytlv.app` through the booking link.
- Make clear that deals come from the live feed and that prices can change
  until the caller books.
- Read back destination, dates, price with currency and direct/connecting,
  and get a clear yes from the caller before sending a link (by voice or
  SMS).

These rules are enforced two ways: by the assistant's base and node
instructions, and by the Stateful Actor validating every `save_deal` /
`send_deal_sms` against the deals it was actually offered (the model cannot
save or text a deal it invented — decision #13).

## What the caller receives

- **Spoken deals.** Two or three of the cheapest deals, each with city and
  country, departure and arrival airports, dates and weekdays, times, airline
  and flight numbers, nights, stops and layovers, price with currency, and —
  when the feed carries them — the percent below the usual price, the savings
  amount and the deal quality (exceptional, great or good).
- **SMS.** A text from "FlyTLV" with the deal's details and the booking link,
  only to the number the caller is calling from. When the actor returned an
  itinerary URL, the SMS body ends with `Itinerary: <url>`.
- **Itinerary page.** A small mobile-friendly HTML page written to Telnyx
  Cloud Storage when a deal is saved. It shows city, country, dates, airline,
  direct vs stops, price + currency and a "Book this flight" button. The
  URL holds a long random UUID (the capability — no password); re-saving the
  same deal reuses the same page.
- **Reminder text.** A short follow-up SMS about `REMINDER_DELAY_SECONDS`
  (default 600 = 10 min) after the save: "Still thinking about <city> for
  <price> <currency>? Your itinerary: <url>".

See [docs/guides/HOW_TO_CALL.md](../guides/HOW_TO_CALL.md) for what to say on
the call.

## Which Telnyx products power it

| Telnyx product | What it does here |
| --- | --- |
| AI Assistant + Conversation Workflow | The voice agent and its 12-node graph (greeting → identify intent → search / save / list / FAQ / transfer / farewell → hangup). Speak nodes deliver verbatim text; prompt nodes drive the model; expression edges route on facts before the model turn; LLM edges route on intent. |
| Telnyx Inference | The model the assistant talks with on every call is `zai-org/GLM-5.3-Flash` on Telnyx Inference (verified by `GET /v2/ai/assistants/{id}`: model `zai-org/GLM-5.3-Flash`, `external_llm` null). |
| MCP | The four tools (`search_deals`, `save_deal`, `list_saved_deals`, `send_deal_sms`) are exposed by an MCP server and called mid-conversation over stateless Streamable HTTP. The conversation id arrives in `params._meta.telnyx_conversation_id`. |
| Edge Functions | The dynamic-variables webhook (Python) and the MCP server (TypeScript) both run as Telnyx Edge Functions. |
| Stateful Actors | One `CallerSession` per caller holds the call count, last-spoken deals and saved deals (atomic read-modify-write). A second `MetricsCounter` actor (one `global` instance) holds service counters and latency. Uses the actor's single **alarm** for the follow-up reminder SMS, and Telnyx **shared actors** so the MCP server binds `CallerSession` directly (no HTTP hop), while the Python webhook still uses the HTTP facade (Python Edge cannot bind actors). |
| KV | Feature flags (toggle workflow paths without a redeploy), the deals search cache (TTL'd), and the conversation → caller mapping the webhook writes and the MCP tools read. |
| Cloud Storage | The `flytlv-itineraries` bucket holds the itinerary HTML pages the actor writes on every save, served by the session-actor function at `GET /itineraries/<uuid>.html`. |
| Messaging | The "FlyTLV" alphanumeric sender (messaging profile `flytlv-sms`, Israel only, $5/day cap) sends the booking-link SMS, the `send_deal_sms` text and the follow-up reminder SMS. Israeli Telnyx numbers are voice-only, so an alphanumeric sender is required. |
| Voice number | `+972765671113` (Israel) is bought and linked to the assistant through a TeXML app ("FLYTLV ai-assistant") → assistant `assistant-77f5cfdc-bdd4-41d9-ba1d-789a8e6e8d16`. |

## Current status and known limits

Status as of 7 Oct 2026 (Israel time):

- The three Edge services are live and shipped by
  [.github/workflows/ship.yml](../../.github/workflows/ship.yml) from Linux
  (the Windows `telnyx-edge` CLI zips paths with backslashes). Live checks:
  `scripts/ops/live_check.py` (20/20 PASS),
  `scripts/ops/workflow_paths.py` (every workflow path over the chat API except the timeout edge, which needs a real phone call),
  `scripts/ops/actor_concurrency_check.py` (20 concurrent updates, none
  lost).
- The phone number `+972765671113` is **bought and linked** to the assistant
  (routed through the TeXML app "FLYTLV ai-assistant"); Telnyx regulatory
  approval is pending (status `requirement-info-pending`), so the number is
  not callable yet. Verified 7 Oct 2026 via `GET /v2/phone_numbers`.
- The assistant is provisioned (`assistant/provision.py`) and its model is
  `zai-org/GLM-5.3-Flash` on Telnyx Inference.

Known limits (factual, from the code):

- **From Tel Aviv only.** Round trips and one-way flights; other departure
  cities are not supported.
- **SMS to Israeli numbers only** (the alphanumeric sender "FlyTLV" and the
  messaging profile are Israel-only; the per-profile spend cap is $5/day).
  Today the account level allows only long-code senders, so the "FlyTLV"
  sender is blocked until the account is upgraded; the agent then says it
  could not send the text — the deal is still saved.
- **One reminder per caller.** A Stateful Actor has one alarm per instance;
  a newer save replaces any pending reminder (the last save wins).
- **Prices come from the live `flytlv.app` feed.** They can change until the
  caller books on `flytlv.app`; flights leaving within 3 hours are dropped
  before they are spoken.
- **A caller with a hidden id (or no conversation id on the channel)** still
  hears deals, but nothing can be saved or texted for them, since saving
  needs a caller identity.
- **The phone number is not callable yet** pending Telnyx regulatory
  approval; a demo is run over the Telnyx portal call tester or the chat API
  in the meantime.

## Attribution

OpenCode with Telnyx-hosted models built the first version of every
component and every change from 7 Oct 2026 (steps 7-15) — including this
document. See [README.md, Tool comparison](../../README.md#tool-comparison).
