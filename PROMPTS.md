# Build prompts for OpenCode (Telnyx Inference)

Run each prompt in order, in this folder, with a Telnyx-hosted model. Example:

```bash
opencode run --model 'telnyx/moonshotai/Kimi-K3' "<prompt>"
```

or paste them into the OpenCode TUI (`opencode`, then `/telnyx` to pick the model).
`AGENTS.md` (rules, structure, platform facts) is loaded automatically.

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
and the three tools search_deals, save_deal, list_saved_deals. Make UnitTest/test_mcp.py pass.

## 4. Session actor
Read AGENTS.md and UnitTest/test_session_actor.test.mts. Build services/session-actor
(src/caller-session.ts, src/index.ts, telnyx.toml, package.json with "test": "tsx --test
../../UnitTest/test_session_actor.test.mts", tsconfig.json). Run npm install and npm test until green.

## 5. Assistant + workflow
Read AGENTS.md and UnitTest/test_assistant.py. Build assistant/flow.py and assistant/provision.py
(Telnyx SDK). Make UnitTest/test_assistant.py pass.

## 6. Docs
Write README.md: architecture diagram, workflow table, how I'd know within a minute that the
assistant is broken, setup and deploy steps. Note which Telnyx model built each component.
