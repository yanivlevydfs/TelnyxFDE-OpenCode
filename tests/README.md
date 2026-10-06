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

Run `python scripts/build/vendor_shared.py` first: the Python tests import each
service's vendored `function/common.py`.

Checks against the **live** Telnyx deployment are in [scripts/ops](../scripts/README.md)
(`live_check.py`, `workflow_paths.py`, `actor_concurrency_check.py`).
