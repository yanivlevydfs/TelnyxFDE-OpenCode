# Decision Log

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| 1 | Every component is an independently deployed microservice with its own folder and manifest | Single function with path routing | Project rule; independent deploys, scaling, logs and metrics per service. |
| 2 | Python for the webhook; TypeScript for the MCP server | Python MCP server (built first, then ported) | Project rule is Python, but Edge builds Python 3.9 and the Python `mcp` SDK needs 3.10+. Python reaches KV through the official `telnyx` SDK (4.182.0). |
| 3 | session-actor in TypeScript | Python-only (no actor) | Stateful Actors are TypeScript-only with no REST fallback; the actor is a required primitive. Kept as a thin HTTP facade. |
| 4 | Shared Python code in ONE file (`shared/common.py`), copied into each service by `scripts/build/vendor_shared.py` | 7-file shared package; copy-paste per service | Edge builds each folder alone; one file is the least code with one source of truth. |
| 5 | Official SDKs: `@modelcontextprotocol/sdk` (MCP server, stateless JSON per request) and `telnyx` (KV, webhook signature check) | Hand-written MCP protocol, KV client and signature check (built first, then deleted) | Less code, maintained by the vendors. A fresh server + stateless transport runs per request. |
| 6 | Webhook degrades to safe defaults under a time budget | Fail the webhook | Telnyx default timeout is 1.5 s; a failed webhook leaves raw `{{vars}}`. `backend_degraded` lets the workflow route to a fallback. |
| 7 | Webhook verifies Telnyx Ed25519 signatures; fails closed if key missing | Trust the public URL | Trust boundary; unauthenticated callers could pollute actor state. |
| 8 | Actor facade uses a method allowlist + bearer token | Expose all actor methods | Public URL; least privilege. |
| 9 | KV only for flags/caches; counters/session in the actor | KV for everything | KV is last-write-wins with no CAS. |
| 10 | Use case: **FlyTLV Travel Line** — phone line to find cheap flights from Tel Aviv via the flytlv.app deals API, save deals, and be remembered on the next call. Chosen by the user 2026-10-04. | Status-only with actor alarms; multi-assistant triage | Real problem (frequent TLV delays/cancellations), builds on the user's existing flytlv.app product and data, exercises every required primitive. |
| 11 | Conversation → caller mapping in KV, written by the webhook | Caller id passed by the LLM as a tool argument | MCP only receives `telnyx_conversation_id`; trusting an LLM-supplied phone number would let the model (or a prompt injection) act on another caller's saved deals. |
| 12 | Expression edges for feature flags, degraded backend, timeout; LLM edges for intent | LLM edges everywhere | Deterministic facts must not depend on model judgement and are evaluated before the model turn. |
| 13 | Deals read aloud are stored in the actor (`setLastResults`); `save_deal` picks from them | LLM passes deal details to save | The model can only save a deal it was actually given — no invented prices or URLs. |
| 14 | **Everything uses Telnyx** — no local stand-ins for KV or the actor | Local KV file + local Node actor for offline demos (built, then removed by the owner) | The challenge requires Telnyx KV and Stateful Actors on Telnyx Edge. Only unit tests use fakes. |
| 15 | OpenCode with Telnyx-hosted models built the first version of every component: GLM-5.2 (shared, MCP, actor, assistant), Kimi-K3 (webhook). After the first deploy, platform fixes and new features were made with Claude Code | Everything in one tool | Challenge requirement 6: "Build your entire solution using Telnyx inference"; the challenge also welcomes comparing tools. Edge-specific failures (Windows CLI paths, Python 3.9 builds, health probes, expired binding) surfaced only on deploy. |
| 16 | Edge functions registered with `telnyx-edge new-func`; `func.toml` uses the official `[edge_compute]` format with the assigned `func_id` | Hand-written manifest with `name` / `runtime` / `entry` keys (first draft, invalid) | `ship` deploys the function named by `func_id`; the docs list no other identity keys. |

| 17 | Ship from Linux in GitHub Actions | `telnyx-edge ship` from the Windows laptop | The Windows CLI (v0.5.9) zips paths with backslashes; Linux builders then see flat files. Proven by shipping the unmodified official scaffold. |
| 18 | MCP server in TypeScript (`@modelcontextprotocol/sdk`, `env.KV` binding) | Python MCP server (built first) | Edge builds Python 3.9; the Python `mcp` SDK needs 3.10+. |
| 19 | Webhook writes the session AFTER its response; flags cached in-process for 60 s; only the actor call is inside the 2.5 s budget | Everything inline under the budget | Telnyx KV over REST measured 1.2-3.7 s per read and ~2 s per write; inline, every call was degraded (metrics: 17/17). The first MCP tool call comes seconds later. |
| 20 | Assistant `dynamic_variables_webhook_timeout_ms` = 8000 | 1500 (default) | Telnyx guidance for Edge Functions: a cold start can exceed 1.5 s. |
| 21 | Service metrics in a second Stateful Actor (`MetricsCounter`, one `global` instance), one batched update per request | KV counters; in-memory counters | KV loses concurrent increments; Edge instances scale to zero. Single instance is fine at call scale; shard by hour if throughput grows. |
| 22 | End the call with a terminal **tool node** running a shared hangup tool; no prompt node has the hangup tool | Prompt node asking the model to call hangup | Deterministic end, and the model cannot hang up mid-conversation (tools scoped per node). MCP tools cannot be scoped per node: only shared tools can. |
| 23 | Deal links by SMS from the alphanumeric sender `FlyTLV` (messaging profile `flytlv-sms`, Israel only, $5/day cap) | SMS from the Israeli number; WhatsApp | Telnyx Israeli numbers are voice-only; WhatsApp is not enabled at the account level (dropped by the owner). |
| 24 | SMS only to the caller's own number and only for a deal they were offered; `sms_enabled` KV flag enforced in the tool | Model-supplied phone number; prompt-only flag | Prevents texting strangers or invented links; the flag is a real kill switch without a redeploy. |
| 25 | Weekend dates (Thu-Sat) and the 3-hour departure cutoff computed on the server in Asia/Jerusalem | Model computes dates | Models mis-compute relative dates; the assistant also gets `{{telnyx_current_time_Asia/Jerusalem}}` (the UTC weekday variable gave the wrong weekday after midnight in Israel). |
| 26 | A caller with a hidden id (or no conversation id) still gets deals read, but nothing is saved | Refuse the search | Better voice UX; saving needs a caller identity. |
| 27 | Model `zai-org/GLM-5.3-Flash` for the assistant | GLM-5.3 | GLM-5.3 is not `recommended_for_assistants` and the API rejects it. |

## Pending decisions

- **Human transfer**: the transfer tool and node exist; they need a `TRANSFER_TO_NUMBER`.
- **Flight status branch** (Israel Airports Authority data): not started; optional.

## Verified on deploy

- `telnyx_conversation_id` is present for calls and chat; it keys the session (call_control_id only feeds the trace id).
- Edge Python 3.9 installs `telnyx[webhooks]`, `httpx`, `starlette` 0.49.3 and `tzdata`.
- The Telnyx MCP client works with `application/json` responses.
- MCP tools are assistant-level and cannot be scoped per node (only shared tools can).
- KV read-after-write between webhook and MCP server works (live end-to-end checks).
