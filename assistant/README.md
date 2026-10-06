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

## Conversation workflow

```
greeting (speak — verbatim disclosure)
  └─ default ─→ identify_intent (prompt — routing hub)
                  ├─ expression  backend_degraded == "true"            → degraded_notice (speak) → farewell
                  ├─ expression  flag_deals_enabled == "false"         → deals_disabled (speak)  → farewell
                  ├─ expression  telnyx_conversation_duration_secs >= N → timeout_escalate (prompt) → transfer_call
                  ├─ llm "search flights"     → search_flights  ─┬─→ save_deal
                  │                                             └─→ identify_intent
                  ├─ llm "save a deal"          → save_deal      ──→ identify_intent
                  ├─ llm "list saved deals"     → list_saved     ──→ identify_intent
                  └─ llm "speak to a human"     → transfer_call  ──→ farewell (speak) → hangup_call (prompt)
```

- **speak nodes** = `greeting`, `degraded_notice`, `deals_disabled`, `farewell` —
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
|---|---|---|
| `caller_known` | `false` | identify_intent prompt (welcome-back) |
| `call_count` | `0` | — |
| `saved_count` | `0` | — |
| `last_saved_deal` | `` | identify_intent prompt (welcome-back) |
| `backend_degraded` | `false` | expression edge → degraded_notice |
| `flag_deals_enabled` | `true` | expression edge → deals_disabled |

## Provisioning (`provision.py`)

Every URL, id, model and voice comes from env vars / Telnyx Edge secrets —
nothing is hardcoded. The CLI runs four steps in order:

1. **integration secret** — stores `MCP_API_KEY` (`/v2/integration_secrets`).
2. **MCP server** — `/ai/mcp_servers` pointing at the deployed MCP Edge Function,
   authenticated with the secret as `api_key_ref`.
3. **assistant** — `/ai/assistants` with the workflow, dynamic-variables
   webhook, MCP server reference and inline `hangup`/`transfer` tools.
4. **phone number** — links an owned number to the assistant's voice connection.

`--dry-run` skips all API calls and prints the assistant body that *would* be
created (used by the unit test).

### Required env vars

| Var | Used for |
|---|---|
| `TELNYX_API_KEY` | SDK auth (injected by the `[telnyx]` Edge binding) |
| `ASSISTANT_MODEL` | assistant `model` (Telnyx-hosted model id) |
| `ASSISTANT_VOICE` | assistant `voice_settings.voice` |
| `WEBHOOK_URL` | `dynamic_variables_webhook_url` (the `fde-webhook` Edge Function URL) |
| `MCP_URL` | the `fde-mcp` Edge Function URL, registered as an MCP server |
| `MCP_API_KEY` | bearer token stored as an integration secret for the MCP server |

### Optional env vars

| Var | Default | Used for |
|---|---|---|
| `ASSISTANT_NAME` | `FlyTLV Travel Line` | assistant name |
| `ASSISTANT_DESCRIPTION` | … | assistant description |
| `ASSISTANT_PHONE_NUMBER` | `` | transfer `from` (caller-id of transferred leg) |
| `TRANSFER_TO_NUMBER` | `` | transfer `to` (human agent); empty ⇒ no transfer tool |
| `ASSISTANT_PHONE_NUMBER_ID` | `` | number id to link to the assistant (step 4) |
| `ASSISTANT_CONNECTION_ID` | `` | voice connection id for the link (else read from the assistant record) |
| `MCP_API_KEY_REF` | `flytlv-mcp-key` | integration secret identifier |
| `MCP_SERVER_NAME` | `flytlv-mcp` | MCP server name |
| `WEBHOOK_TIMEOUT_MS` | `1500` | dynamic-variables webhook timeout |
| `CONVERSATION_TIMEOUT_SECS` | `300` | the duration comparison for the escalation edge |

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
.venv/Scripts/python -m pytest UnitTest/test_assistant.py -q   # this component
.venv/Scripts/python -m pytest UnitTest -q                     # everything
```

## Observability

`provision.py` logs each step as structured JSON via `shared/common.py`
(`provision.integration_secret`, `provision.mcp_server`, `provision.assistant`,
`provision.phone_linked` / `provision.phone_link_manual`). The phone-number link
is the one soft step: if Telnyx does not expose a connection id for the
assistant the number is left unlinked with a warning rather than aborting an
otherwise-complete assistant.
