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
|---|---|---|---|
| 1 | Shared code | GLM-5.2 | Done: 13/13 tests pass |
| 2 | Webhook | Kimi-K3 | Done: 9/9 tests pass; `func.toml` fixed to the official format |
| 3 | MCP server | GLM-5.2 | Stopped by error 20015 before writing files; rerun |
| 4 | Session actor | GLM-5.3 | Stopped by error 20015; rerun |
| 5 | Assistant + workflow | — | Not started |
| 6 | Docs | — | Not started |

## 1. Shared code

Read AGENTS.md and UnitTest/test_common.py. Write shared/common.py so every test in
UnitTest/test_common.py passes. Run `.venv/Scripts/python -m pytest UnitTest/test_common.py -q`
and fix until green. Then write scripts/vendor_shared.py.

## 2. Webhook

Read AGENTS.md, spec/ and UnitTest/test_webhook.py. Build services/webhook (function/func.py,
function/__init__.py, pyproject.toml, func.toml, README.md). Run
`python scripts/vendor_shared.py` then `.venv/Scripts/python -m pytest UnitTest/test_webhook.py -q`
and fix until green.

## 3. MCP server

Read AGENTS.md and UnitTest/test_mcp.py. Build services/mcp-server with the official mcp SDK
and the three tools search_deals, save_deal, list_saved_deals. Use the official `func.toml`
format from AGENTS.md with the registered `fde-mcp` func_id. Make UnitTest/test_mcp.py pass.

## 4. Session actor

Read AGENTS.md and UnitTest/test_session_actor.test.mts. Build services/session-actor
(src/caller-session.ts, src/index.ts, telnyx.toml, package.json with "test": "tsx --test
../../UnitTest/test_session_actor.test.mts", tsconfig.json). `recordCall` must return the
full profile (callCount, savedCount, lastSaved). Run npm install and npm test until green.

## 5. Assistant + workflow

Read AGENTS.md and UnitTest/test_assistant.py. Build assistant/flow.py and assistant/provision.py
(Telnyx SDK). Make UnitTest/test_assistant.py pass.

## 6. Docs

Update README.md: architecture diagram, workflow table, how I'd know within a minute that the
assistant is broken, setup and deploy steps. Note which Telnyx model built each component.

## Small fixes queued

- shared/common.py: read the trace header name from `TRACE_HEADER` (default `x-trace-id`)
  instead of hardcoding it. Keep UnitTest/test_common.py green.
