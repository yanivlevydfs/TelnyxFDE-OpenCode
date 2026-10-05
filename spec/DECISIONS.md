# Decision Log

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | Every component is an independently deployed microservice with its own folder and manifest | Single function with path routing | Project rule; independent deploys, scaling, logs and metrics per service. |
| 2 | Python for webhook and MCP server | TypeScript everywhere | Project rule. Python reaches Telnyx KV through the official `telnyx` SDK (4.182.0). |
| 3 | session-actor in TypeScript | Python-only (no actor) | Stateful Actors are TypeScript-only with no REST fallback; the actor is a required primitive. Kept as a thin HTTP facade. |
| 4 | Shared Python code in ONE file (`shared/common.py`), copied into each service by `scripts/vendor_shared.py` | 7-file shared package; copy-paste per service | Edge builds each folder alone; one file is the least code with one source of truth. |
| 5 | Official SDKs: `mcp` (MCP server, stateless JSON per request) and `telnyx` (KV, webhook signature check) | Hand-written MCP protocol, KV client and signature check (built first, then deleted) | Less code, maintained by the vendors. Edge has no ASGI lifespan, so a stateless MCP session manager runs per request. |
| 6 | Webhook degrades to safe defaults under a time budget | Fail the webhook | Telnyx default timeout is 1.5 s; a failed webhook leaves raw `{{vars}}`. `backend_degraded` lets the workflow route to a fallback. |
| 7 | Webhook verifies Telnyx Ed25519 signatures; fails closed if key missing | Trust the public URL | Trust boundary; unauthenticated callers could pollute actor state. |
| 8 | Actor facade uses a method allowlist + bearer token | Expose all actor methods | Public URL; least privilege. |
| 9 | KV only for flags/caches; counters/session in the actor | KV for everything | KV is last-write-wins with no CAS. |
| 10 | Use case: **FlyTLV Travel Line** — phone line to find cheap flights from Tel Aviv via the flytlv.app deals API, save deals, and be remembered on the next call. Chosen by the user 2026-10-04. | Status-only with actor alarms; multi-assistant triage | Real problem (frequent TLV delays/cancellations), builds on the user's existing flytlv.app product and data, exercises every required primitive. |
| 11 | Conversation → caller mapping in KV, written by the webhook | Caller id passed by the LLM as a tool argument | MCP only receives `telnyx_conversation_id`; trusting an LLM-supplied phone number would let the model (or a prompt injection) act on another caller's saved deals. |
| 12 | Expression edges for feature flags, degraded backend, timeout; LLM edges for intent | LLM edges everywhere | Deterministic facts must not depend on model judgement and are evaluated before the model turn. |
| 13 | Deals read aloud are stored in the actor (`setLastResults`); `save_deal` picks from them | LLM passes deal details to save | The model can only save a deal it was actually given — no invented prices or URLs. |
| 14 | **Everything uses Telnyx** — no local stand-ins for KV or the actor | Local KV file + local Node actor for offline demos (built, then removed by the owner) | The challenge requires Telnyx KV and Stateful Actors on Telnyx Edge. Only unit tests use fakes. |

## Pending decisions

- **Workflow** — FlyTLV nodes and edges for the assistant (next step, needs the Telnyx API key).
- **Flight status branch** (Israel Airports Authority data) and **SMS** — not started; optional.
- **Telnyx Inference model** for OpenCode (Kimi-K3, GLM-5.x, ...).

## Assumptions to verify on first deploy

- `[env_vars]` is honored in `telnyx.toml` (actor service falls back to defaults if not).
- `telnyx_conversation_id` is present in the webhook payload (example payload omits it; code falls back to `call_control_id`).
- Edge Python build installs `pyproject.toml` dependencies (`httpx`, `cryptography`).
- Telnyx MCP client accepts `application/json` responses (no SSE).
- Whether a node with `tools_mode: replace` hides assistant-level MCP tools (MCP scoping per node is not exposed by the API).
- KV read-your-writes between webhook and MCP server for the session mapping (same region expected).
