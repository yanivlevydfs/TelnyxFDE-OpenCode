# Dogfooding notes: OpenCode + Telnyx Inference

The challenge asks to build with Telnyx Inference through the `@telnyx/opencode`
plugin and to note what works well and what does not. These are the notes from
this build. Which model built what is in the
[README](../../README.md#which-model-built-each-component).

## Setup

- Plugin in [.opencode/opencode.json](../../.opencode/opencode.json); credential via
  `opencode auth login --provider telnyx --method "API Key"`; enabled models in
  `telnyx-models.json` (Kimi-K3, GLM-5.2, GLM-5.3, DeepSeek-V4.1-Flash, Qwen3.8,
  MiniMax, ...).
- Each component was built with one prompt from [PROMPTS.md](PROMPTS.md) against
  the acceptance tests, then the tests were run.

## What worked well

- **Test-first prompts.** Giving the model the acceptance tests and a short rules
  file ([AGENTS.md](../../AGENTS.md)) produced code that passed the tests in few
  iterations: GLM-5.2 built the shared code, MCP server, actor and assistant;
  Kimi-K3 built the webhook.
- **GLM-5.2 for multi-file work**, including the MCP server's port from Python to
  TypeScript when the Edge Python build turned out to be 3.9.
- **Telnyx-hosted models in the product too:** the assistant itself runs on
  GLM-5.3-Flash.

## What did not work well

- **Credit stops are hard stops.** When the balance went negative, inference
  returned error 20015 mid-step and OpenCode stopped with partial work; two build
  steps had to be rerun after credit arrived.
- **Token cost from global context.** With the default config every request
  carried ~215k tokens (all globally installed skills and MCP servers were loaded).
  A clean config directory (`XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointing at a
  project-only config, plus `OPENCODE_DISABLE_CLAUDE_CODE=1` and
  `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`) brought it to ~8.7k tokens per request.
- **Desktop app and CLI share one database.** After the desktop app migrated the
  shared `opencode.db`, the CLI failed with `no such column: project_id`; a
  separate data directory for the CLI fixed it.
- **Platform knowledge gaps.** The models could not know Edge specifics that only
  appear on deploy (Python 3.9 builds, `/health/*` probes, KV key characters, the
  Windows CLI zip paths). Those were found from logs and fixed after the first
  deploy (see the README's "What broke during development").

## Model choice for the assistant

GLM-5.3 is not `recommended_for_assistants` in `/v2/ai/models`, and the API
rejects it for an assistant; GLM-5.3-Flash is the closest allowed model and is
fast enough for voice.

## Today (7 Oct 2026) — building steps 7-12 in OpenCode with GLM-5.2

Steps 7-12 (itinerary file + reminder alarm, shared actor binding, the
assistant flow upgrade, the root README updates, the live `[env_vars]` bug fix
and this docs sweep) were all built with OpenCode powered by Telnyx Inference
on `zai-org/GLM-5.2`.

- **Two parallel `opencode run` processes sharing one `XDG_DATA_HOME` hang
  silently.** Running a second `opencode run` alongside a first one with the
  same data directory froze both: no progress, no error, no output, until one
  was killed. The fix is one data dir per process — point each `opencode run`
  at its own `XDG_DATA_HOME` (and `XDG_CONFIG_HOME`) so they do not contend on
  the shared SQLite/AntiSync files. Worth a note in the agent's environment
  setup the next time we run multi-step builds in parallel.
- **A Kimi-K3 run hung and was replaced by GLM-5.2.** The first attempt at
  step 9 (assistant flow upgrade) on `moonshotai/Kimi-K3` produced no output
  for several minutes; stopping it and rerunning on `zai-org/GLM-5.2`
  completed the step cleanly. (The earlier Kimi-K3 stops in the build were
  credit stops — error 20015 — this one was a hang, distinct.) Recorded in
  `PROMPTS.md`.
- **The live bug: umbrella `[env_vars]` do not reach actor instances' `process.env`.**
  After the step 7-8 deploy the `fde-session-actor` logs showed
  `itinerary_skipped reason=noITINERARY_BASE_URL` on every save, even though
  `[env_vars] ITINERARY_BASE_URL = "..."` was set in the umbrella `telnyx.toml`.
  The Cloud Storage bucket binding (`[storage.cloudstorage.ITINERARIES]`) *did*
  reach the actor, and the MCP `func.toml [env_vars]` *did* reach the MCP
  function — only the actor umbrella `[env_vars]` were silently dropped. The
  fix (step 11) keeps the actor's `telnyx.toml [env_vars]` as the unit-test /
  local-dev fallback, but the MCP server now forwards the four
  itinerary/reminder values on every `saveDeal` call in a `config` field, and
  the actor resolves `config.X ?? process.env.X`. See DECISIONS #28 and #29.
- **A path-test script left a live assistant behind.** An earlier
  `scripts/ops/workflow_paths.py` run (01:42 Israel time) left its throwaway
  "FlyTLV Travel Line (path test)" assistant and TeXML app on the account to be
  deleted by hand: the `finally` block chained the retrieve, assistant delete
  and TeXML delete, so one failing call (e.g. `retrieve`) skipped the deletes
  after it. Fixed by sweeping leftover " (path test)" assistants before creating
  a new copy and wrapping each cleanup call in its own try/except, so a failure
  logs ERROR with a traceback and the remaining deletes still run.
