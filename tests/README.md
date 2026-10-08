# Tests

Acceptance tests define the job: the solution is done when they all pass, and
they are not edited to make code pass (see [AGENTS.md](../AGENTS.md)). The
`check_*` files are extra self-checks for behaviour added after the first build.

## Acceptance tests

| File | Covers | Run |
| --- | --- | --- |
| `test_common.py` | `shared/common.py`: config, JSON logging, KV wrapper, actor client, phone helpers | `.venv/Scripts/python -m pytest tests -q` |
| `test_webhook.py` | Dynamic Variables webhook: signature check, variables, degraded defaults, time budget | (same command; 29 Python tests in total) |
| `test_assistant.py` | Workflow graph, expression-edge variables and defaults, tools, provisioning body | (same command) |
| `test_mcp.test.mts` | MCP server: auth, tools, cache, actor errors, `slim()` | `cd services/mcp-server && npm test` (11) |
| `test_session_actor.test.mts` | CallerSession actor and its HTTP facade | `cd services/session-actor && npm test` (7) |
| `conftest.py` | Loads each Python service as a package with test env values | used by pytest |

## Self-checks

| File | Covers | Run |
| --- | --- | --- |
| `check_search_filters.mts` | Weekend dates (Asia/Jerusalem), country filter, departure cutoff, SMS text | `cd services/mcp-server && npx tsx ../../tests/check_search_filters.mts` |
| `check_metrics.mts` | MetricsCounter actor and the facade's `/metrics` routes | `cd services/session-actor && npx tsx ../../tests/check_metrics.mts` |
| `check_webhook_metrics.py` | The webhook reports metrics after responding | `.venv/Scripts/python tests/check_webhook_metrics.py` |
| `check_itinerary.mts` (step 7) | Itinerary file in Cloud Storage (write + reuse the same key on re-save), actor alarm (`reminder_scheduled`, `alarm.sms_sent`, at-least-once), the public `GET /itineraries/<slot>-<token>.html` route with slot+token validation and `404` on a bad shape / out-of-range slot / missing object / token mismatch, the step-11 "config travels with the call" path (no `process.env`, `config` only → `itineraryUrl` returned and the SMS sent with the passed `smsFrom` / `messagingProfileId`), bad-typed config being dropped in favour of the `process.env` fallback, and the step-22b design (one token per caller, reused on every save → re-saves keep the same URL and both GETs return 200; a different caller hashing to the same slot makes the first caller's link 404) | `cd services/session-actor && npm run check` |
| `check_flow_capabilities.py` (step 9) | The upgraded Conversation Workflow covers every capability the step-9 prompt lists (named destination, "anywhere", one-way, direct/connecting, cheapest-first, travel patterns, follow-ups, send-by-SMS, transfer, hangup, the safety rules), each mapped only to `search_deals` arguments the tool actually exposes; unacknowledged MCP gaps must be listed in `assistant/README.md` under "MCP gaps" | `.venv/Scripts/python -m pytest tests/check_flow_capabilities.py -q` |
| `check_history.mts` (step 20) | CallerSession search/save history (`searchHistory`) append + cap by `SEARCH_HISTORY_MAX`, save entry, audit JSON object written to Cloud Storage with a **masked caller**, audit failure never fails the call, and the `POST /actors/{digits}/getHistory` route (bearer auth) | `cd services/session-actor && npm run check` |
| `check_insights.py` (step 20) | `assistant/provision.py` wires `insight_settings.insight_group_id` on the assistant body and declares the four caller-intent insight definitions (dry-run shape; no API calls) | `.venv/Scripts/python -m pytest tests/check_insights.py -q` |
| `check_env.py` (step 21) | Owner rule 3 guard ("nothing hardcoded"): every environment variable any `.py` / `.ts` source reads is declared in `.env.example`; the X_ test-sentinel convention in `tests/test_common.py` is filtered out, and prompt/speak text, tool names, storage key names and regexes are code/content (not settings) | `.venv/Scripts/python -m pytest tests/check_env.py -q` |

Run `python scripts/build/vendor_shared.py` first: the Python tests import each
service's vendored `function/common.py`.

Checks against the **live** Telnyx deployment are in [scripts/ops](../scripts/README.md)
(`live_check.py`, `workflow_paths.py`, `actor_concurrency_check.py`).
