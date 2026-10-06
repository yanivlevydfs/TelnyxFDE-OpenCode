# webhook — Dynamic Variables for the FlyTLV Travel Line

Python Telnyx Edge Function. Telnyx POSTs `assistant.initialization` here once
at call start; we answer with flat string-only `dynamic_variables` the
Conversation Workflow uses for greetings (`last_saved_deal`) and
expression-edge routing (`backend_degraded`, `flag_*`).

## Request flow

1. **Verify** the Telnyx Ed25519 signature + timestamp window via the official
   SDK (`client.webhooks.unwrap`) — *before* parsing the body. Bad/stale →
   `401`, invalid JSON → `400`.
2. In **parallel, under `WEBHOOK_BUDGET_MS` (2.5 s)**:
   - read feature flags from KV (`KV_FLAGS_KEY`), cached in memory for
     `FLAGS_CACHE_SECS` (60 s) because a Telnyx KV read takes 1-4 s;
   - call `CallerSession.recordCall` on the caller's Stateful Actor
     (entity id = caller's E.164 phone, digits only).
3. Return `{"dynamic_variables": {...}}`. Only an actor failure sets
   `backend_degraded="true"`; a failed flags read falls back to default flags.
4. **After the response** (Starlette background task): write
   `session/<telnyx_conversation_id> → {"entity_id": ...}` in KV (TTL
   `SESSION_TTL`) so the MCP tools can resolve the caller, and send this call's
   counters and latency to the `MetricsCounter` actor. A KV write takes ~2 s, and
   the first tool call comes seconds later, after the greeting.

## Variables returned

| Variable | Source | Example |
| --- | --- | --- |
| `caller_known` | actor profile present | `true` |
| `call_count` | actor `callCount` | `3` |
| `saved_count` | actor `savedCount` | `1` |
| `last_saved_deal` | actor `lastSaved` | `Larnaca, 64 USD` |
| `backend_degraded` | any dependency failed/timed out | `false` |
| `flag_<name>` | scalar KV flags (bools → `true`/`false`) | `flag_deals_enabled=true` |

On dependency failure/timeout the webhook still answers 200 with safe defaults
(`caller_known="false"`, counts `0`) and `backend_degraded="true"` so the
workflow can route to a fallback instead of reading raw `{{placeholders}}`.
Anonymous callers (no `telnyx_end_user_target`) skip the actor and the mapping.

## Files

- `function/func.py` — routes, dependency fan-out, variable formatting, `new()`.
- `function/common.py` — vendored `shared/common.py` (`python scripts/build/vendor_shared.py`).
- `pyproject.toml` — Edge-installed dependencies (hatchling).
- `func.toml` — Edge manifest: `[telnyx]` binding + non-secret `[env_vars]`.

## Configuration

Everything comes from env vars / Edge secrets — nothing is hardcoded:
`TELNYX_API_KEY` (injected by the `[telnyx]` binding), `TELNYX_PUBLIC_KEY`,
`KV_NAMESPACE_ID`, `ACTOR_SERVICE_URL`, `INTERNAL_API_TOKEN` (secrets);
`WEBHOOK_VERIFY_SIGNATURE`, `WEBHOOK_BUDGET_MS`, `HTTP_TIMEOUT_MS`,
`KV_FLAGS_KEY`, `SESSION_KEY_PREFIX`, `SESSION_TTL` (`func.toml`).

## Observability

Structured JSON logs via `common`: a `webhook.request` span per call with
`trace_id` (= `telnyx_conversation_id`), masked caller, `duration_ms` and
`outcome` (`ok` / `degraded` / `rejected`), plus one
`webhook.dependency_failed` ERROR per failing dependency with a traceback.

## Test & deploy

The function is already registered: `func_id = "e5907143-e572-4e86-8880-0de76f057561"`, pinned in `func.toml` under `[edge_compute]`.

```bash
python scripts/build/vendor_shared.py
.venv/Scripts/python -m pytest tests/test_webhook.py -q
telnyx-edge ship --from-dir services/webhook
```
