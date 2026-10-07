# Documentation

| Folder | File | What it is for |
| --- | --- | --- |
| `challenge/` | [code_challenge.md](challenge/code_challenge.md) | The Telnyx FDE challenge brief (requirements, judging criteria) |
|  | [USE_CASE.md](challenge/USE_CASE.md) | The FlyTLV Travel Line use case and why it fits the challenge |
| `design/` | [ARCHITECTURE.md](design/ARCHITECTURE.md) | Components, data flow, and which primitive (Actor / KV / function) holds each piece of state |
|  | [PRODUCT.md](design/PRODUCT.md) | The product brief for the FlyTLV Travel Line (audience: reviewers/product, non-engineers) |
|  | [DECISIONS.md](design/DECISIONS.md) | Decision log with the alternatives considered |
|  | [OBSERVABILITY.md](design/OBSERVABILITY.md) | Logs, latency spans, trace id, metrics, and how to spot a broken assistant within a minute |
| `guides/` | [HOW_TO_CALL.md](guides/HOW_TO_CALL.md) | For callers: what to say to the phone agent and what you get back |
|  | [INTEGRATION.md](guides/INTEGRATION.md) | Every integration point, config reference, deploy, testing, troubleshooting (audience: engineers) |
|  | [DEMO_SCRIPT.md](guides/DEMO_SCRIPT.md) | The 8–10 minute demo-day walkthrough |
| `build/` | [PROMPTS.md](build/PROMPTS.md) | The OpenCode (Telnyx Inference) build prompts, one per component |
|  | [DOGFOODING.md](build/DOGFOODING.md) | What worked and what did not with OpenCode + Telnyx Inference |

The project overview, live endpoints and setup are in the [README](../README.md).
