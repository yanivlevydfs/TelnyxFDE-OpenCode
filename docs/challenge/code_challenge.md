# AI Assistant & Edge Compute Coding Challenge

Welcome to the Telnyx coding challenge! We're excited to see what you'll build with our Voice AI platform, Edge Compute products, and the Model Context Protocol (MCP). This is your chance to get creative and showcase your skills while diving deep into some cutting-edge tech.

---

## The Challenge

Build an AI Assistant powered by Telnyx that integrates with a custom MCP (Model Context Protocol) server, runs on Telnyx Edge Compute, and uses Conversation Workflows for structured multi-step interactions. Your assistant should solve a real-world problem and demonstrate the power of combining Voice AI with edge-deployed stateful services and external data sources.

You'll build this entire solution using **Telnyx Inference** as your AI coding model via the OpenCode plugin — dogfooding our own LLM hosting while you build on our platform.

---

## Core Requirements

### 1. AI Assistant with Conversation Workflow (Required)

- Create a Telnyx AI Assistant using our Portal Assistant Builder or the Assistants API
- **Design a Conversation Workflow** with multiple nodes — not just a single prompt
  - Use **prompt nodes** for LLM-driven conversation steps (e.g., `Greeting & Identify Intent`, `Collect Details`, `Confirm`)
  - Use at least one **speak node** for a verbatim scripted message (greeting, disclosure, compliance statement)
  - Configure **conditional edges** between nodes (LLM conditions for intent-based routing, variable comparisons for deterministic routing)
- Must be callable via phone number
- Should handle real conversational interactions with multi-step flow

**Example workflow structure:**
```
Greeting (speak node)
  → Identify Intent (prompt node)
      ├── Answer FAQ        when caller asks general questions
      ├── Collect Details    when caller needs to provide information
      └── Escalate           when caller requests a human
```

### 2. MCP Server Integration (Required)

- Build a custom MCP server that your AI Assistant can interact with
- Server should provide meaningful tools/resources to enhance your assistant
- Examples: database queries, API integrations, file operations, calculations, etc.
- Expose at least 3 tools that your assistant's workflow nodes can call

### 3. Dynamic Webhook Variables (Required)

- Implement Dynamic Webhook Variables in your assistant
- Use these to personalize interactions or fetch contextual data
- **Your webhook endpoint must be deployed as a Telnyx Edge Function** (see requirement 4)
- Show how dynamic data enhances the conversation flow and influences workflow routing

### 4. Telnyx Edge Compute Deployment (Required)

Deploy your backend on Telnyx Edge Compute — not Vercel, Railway, or Heroku. This is where you use the newest edge products:

#### 4a. Edge Functions
- Deploy at least one **Telnyx Edge Function** to serve your dynamic webhook endpoint
- Use `telnyx-edge ship` to deploy
- Your function handles webhook requests from the AI Assistant and returns dynamic variables

#### 4b. KV (Key-Value Store)
- Use **Telnyx KV** in your Edge Function for at least one of:
  - Session data (caller session state across webhook calls)
  - Cached responses (avoid redundant API calls to external services)
  - Feature flags (toggle assistant behavior without redeploying)
- Access KV via the `env` binding (TypeScript) or the REST API (other languages)

#### 4c. Stateful Actors
- Implement at least one **Stateful Actor** to manage per-entity state
- The actor should own state for a single entity (one user, one call session, one order, etc.)
- Use the actor's single-threaded execution model for a read-modify-write operation that would otherwise need a lock
- Examples: per-caller call counter, user profile accumulator, shopping cart, session state manager

```typescript
import { StatefulActor } from "@telnyx/edge-runtime";

export class CallSession extends StatefulActor {
  async recordCall(callerId: string, intent: string): Promise<{ callCount: number }> {
    const count = (await this.ctx.storage.get<number>("callCount")) ?? 0;
    await this.ctx.storage.put("callCount", count + 1);
    await this.ctx.storage.put("lastIntent", intent);
    return { callCount: count + 1 };
  }
}
```

### 5. Observability (Required)

You're deploying production services — prove you can see inside them:

- **Structured logging** on your Edge Function: every webhook call logged with enough context (caller, node, outcome) to reconstruct what happened
- At least **one meaningful signal beyond logs** — a counter, a latency measurement, or a trace of a single request's path through Function → KV/Actor → MCP
- Include in your README: how you'd know, within a minute of it happening, that your assistant was broken — and what you'd look at first
- Be ready on demo day to walk us through **one thing that broke during development and how you found it** — evidence, not vibes

### 6. Telnyx Inference via OpenCode Plugin (Required)

- Install the `@telnyx/opencode` plugin in your development environment
- Authenticate with your Telnyx API key: `opencode auth login --provider telnyx --method "API Key"`
- Use **Telnyx-hosted LLMs** as your AI coding model — pick from the current model list via the `/telnyx` TUI command (GLM-5.x, Kimi-K3, DeepSeek-V4, Qwen3.8, MiniMax, etc.)
- Build your entire solution using Telnyx inference as the model powering your AI coding assistant
- This dogfoods Telnyx's own inference product and tests your ability to configure AI tooling

```bash
# Install the plugin
opencode plugin @telnyx/opencode

# Authenticate with Telnyx
opencode auth login --provider telnyx --method "API Key"

# Run with a Telnyx-hosted model
opencode run --model 'telnyx/moonshotai/Kimi-K3' 'Say hello in one sentence.'
```

*(Model IDs update as new releases land — run `/telnyx` in the OpenCode TUI or check `~/.config/opencode/telnyx-models.json` for the current list.)*

### 7. Public Deployment & Documentation (Required)

- Deploy your Edge Functions publicly (Telnyx Edge handles this via `telnyx-edge ship`)
- Provide working URLs and phone numbers we can test
- Include clear documentation on how to interact with your assistant
- Your MCP server must be publicly accessible

---

## Stretch Goals (Bonus — Not Required, But Impressive)

These are not required, but completing them demonstrates deeper mastery of the platform:

- **Multi-assistant routing**: Route from your main workflow to a secondary assistant with a different persona/model/tools
- **Variable comparison edges**: Use deterministic routing based on system variables (e.g., `telnyx_conversation_duration_secs >= 300` for escalation after timeout)
- **Alarms in Stateful Actors**: Schedule future work from inside an actor (e.g., send a follow-up reminder)
- **Object storage integration**: Use Telnyx Cloud Storage (S3-compatible) for media files, recordings, or documents
- **KV-based feature flags**: Toggle workflow paths without redeploying by reading a flag from KV
- **Shared actors**: Access one actor from multiple functions
- **Custom dynamic variables webhook**: Return custom variables that influence workflow routing decisions
- **Distributed tracing**: Correlate a single call's path across Assistant → Function → KV/Actor → MCP with a shared request ID

---

## Technical Freedom

- **Languages**: TypeScript, JavaScript, Go, Python, or Java (Edge Functions support all five; KV `env` binding is TypeScript-only — other languages use the REST API)
- **Any framework** for your MCP server
- **AI coding assistants** — You MUST use Telnyx Inference via OpenCode (that's the point), but you're welcome to compare with other tools
- **Any databases/services** — but prefer KV and Stateful Actors over external caches/databases where the use case fits

---

## Inspiration & Use Case Ideas

Need some inspiration? Here are directions that work well with Conversation Workflows + Edge Compute:

- **Smart Receptionist**: Workflow greets → identifies intent → checks calendar (MCP tool) → books appointment. Stateful Actor tracks booking state per caller. KV caches availability.
- **Support Agent**: Workflow triages → collects issue details → checks knowledge base (MCP) → escalates after timeout. Stateful Actor tracks ticket state. KV caches KB responses.
- **Order Intake**: Workflow collects item → confirms quantity → processes payment (MCP) → confirms. Stateful Actor manages the cart per caller. KV caches product catalog.
- **Appointment Scheduler**: Workflow collects request → collects availability → confirms details → final confirmation. Stateful Actor tracks per-user booking state across calls.
- **Verification Flow**: Speak node delivers compliance disclosure → prompt node collects info → variable comparison routes based on verification status. Stateful Actor tracks attempt count.
- **Multi-Assistant Triage**: Main assistant routes to billing, technical, or sales specialist assistants via workflow edges. Each specialist has its own model, voice, and tools.

The key is picking something that genuinely benefits from multi-step conversation structure and per-entity state!

---

## What We're Looking For

### Technical Excellence

- Clean, readable code with good architecture
- Proper error handling and edge cases
- **Smart use of Conversation Workflows** — nodes are focused, edges have clear conditions, speak nodes used where verbatim delivery matters
- **Correct use of Stateful Actors** — applied where single-threaded per-entity state is the right primitive, not shoehorned into every problem
- **Pragmatic use of KV** — for the right workload (cache, session, flags), not as a database replacement
- **Evidence-driven debugging** — when something broke, you found it with your observability, not by guessing; you can show the trail
- Creative implementation of Dynamic Webhook Variables backed by Edge Functions
- Smart use of MCP to extend assistant capabilities

### Platform Understanding

- Choosing the right edge primitive for each job (Function vs. Actor vs. KV)
- Understanding when a workflow node should append vs. replace instructions
- Scoping tools per workflow node appropriately
- Using variable comparisons vs. LLM conditions for the right routing decisions

### Innovation & Creativity

- Unique or interesting use case that leverages the multi-step workflow
- Thoughtful UX for voice interactions
- Creative problem-solving with stateful edge services
- Effective use of Telnyx-hosted inference for development

### Real-world Viability

- Solves an actual problem
- Handles realistic conversation flows with proper edge cases
- Demonstrates practical value of the edge architecture
- Shows the workflow handles the happy path AND fallback paths

---

## Demo Day

### 1. Live Demo (8–10 mins)

The demo should clearly demonstrate:
- The conversation workflow (multiple steps, not a single exchange)
- MCP integration (a tool call happening during the conversation)
- Dynamic webhook functionality (personalized data flowing into the conversation)
- Edge Compute in action (show your function deployed, KV reads/writes, actor state)
- Your observability surface — logs or metrics visible while the demo runs

### 2. Live Walkthrough & Decision Review (7–10 mins)

Walk us through your architecture and key implementation decisions. Be prepared to explain:
- Why you chose your specific use case
- How you structured your Conversation Workflow (node design, edge conditions)
- How you structured your MCP server
- How Dynamic Webhook Variables are being used
- **Why you chose Stateful Actors vs. KV vs. plain function logic** for each piece of state
- **How you used Telnyx Inference via the OpenCode plugin** and what model(s) you chose
- **How you found the hardest bug you hit** — what signal led you to it
- Tradeoffs you considered (e.g., LLM conditions vs. variable comparisons for routing)
- How you handled edge cases and errors

### 3. Interactive Q&A (5 mins)

We'll ask follow-up questions about your technical decisions, design choices, and potential improvements.

---

## What to Prepare

- Working phone number we can dial
- Live Edge Function URL(s) for your webhook and MCP server
- Clear explanation of your use case and target users
- Architecture diagram showing: Assistant → Workflow → Edge Function → KV/Actor → MCP
- Code walkthrough of key components
- Discussion of challenges and interesting solutions
- Your observability story: what you instrumented, and the debugging trail for one real bug
- Show your OpenCode config with the Telnyx plugin active

---

## Getting Started

### Step 1: Set Up Telnyx Inference via OpenCode

```bash
# Install OpenCode (if not already installed)
# See https://opencode.ai for installation

# Install the Telnyx plugin
opencode plugin @telnyx/opencode

# Authenticate with your Telnyx API key
opencode auth login --provider telnyx --method "API Key"

# Verify models are available (pick any from the current list)
opencode run --model 'telnyx/moonshotai/Kimi-K3' 'List the Telnyx models you know about.'

# Or try a different hosted model
opencode run --model 'telnyx/zai-org/GLM-5.3' 'Hello from Telnyx inference!'
```

The plugin auto-recommended models update with each release — current families include `moonshotai/Kimi-K3`, `zai-org/GLM-5.x`, `deepseek-ai/DeepSeek-V4`, and Qwen3.x. Manage which models are enabled via the `/telnyx` TUI command or by editing `~/.config/opencode/telnyx-models.json`.

### Step 2: Set Up Telnyx Edge Compute

```bash
# Install the Telnyx Edge CLI (Linux amd64 — for macOS, see the releases page for the right archive)
curl -fsSL https://github.com/team-telnyx/edge-compute/releases/latest/download/telnyx-edge-linux-amd64.tar.gz | tar xz
sudo mv telnyx-edge /usr/local/bin/

# Scaffold a new function
telnyx-edge new-func my-webhook -l typescript

# Navigate to your function
cd my-webhook

# Review the generated func.toml — add KV and Actor bindings here

# Deploy your function
telnyx-edge ship

# Your function is live at:
# https://my-webhook-<your-org>.telnyxcompute.com
```

### Step 3: Create Your AI Assistant with a Workflow

1. Go to **AI Assistants** in the Telnyx Portal
2. Create a new assistant
3. Open the **Workflow** tab
4. Add nodes for each conversation stage
5. Connect nodes with edges and configure conditions
6. Save the assistant
7. Assign a phone number to the assistant

Or use the Assistants API to define `conversation_flow` programmatically.

### Step 4: Build Your MCP Server

Build your MCP server in any language. It must be publicly accessible so your assistant can reach it. You can deploy it as an Edge Function or on any public host.

---

## Resources & Support

### Getting Started
- Create a Telnyx Account
  - If you experience issues with the signup flow, please contact Stephen — free emails can get stuck
- Use PromoCode **TELNYXFDE2026** to add credit

### Edge Compute Documentation
- [Edge Compute Overview](https://developers.telnyx.com/docs/edge-compute/overview)
- [Edge Functions Quickstart](https://developers.telnyx.com/docs/edge-compute/quickstart)
- [Stateful Actors](https://developers.telnyx.com/docs/edge-compute/stateful-actors)
- [Stateful Actors Quick Start](https://developers.telnyx.com/docs/edge-compute/stateful-actors/quick-start)
- [Stateful Actors — How It Works](https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/how-it-works)
- [KV (Key-Value Store)](https://developers.telnyx.com/docs/edge-compute/kv)
- [KV Quick Start](https://developers.telnyx.com/docs/edge-compute/kv/quick-start)
- [Bindings](https://developers.telnyx.com/docs/edge-compute/runtime/bindings)
- [Edge CLI Reference](https://developers.telnyx.com/docs/edge-compute/reference/cli)
- [Telnyx API from Functions](https://developers.telnyx.com/docs/edge-compute/telnyx-api)
- [Logs & Metrics](https://developers.telnyx.com/docs/edge-compute/reference/logs-metrics)

### AI Assistant & Inference Documentation
- [Conversation Workflows](https://developers.telnyx.com/docs/inference/ai-assistants/workflows)
- [Dynamic Variables](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables)
- [AI Assistants API](https://developers.telnyx.com/api-reference/assistants/create-an-assistant)
- [Version Testing & Traffic Distribution](https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution)
- [Integrations](https://developers.telnyx.com/docs/inference/ai-assistants/integrations)

### OpenCode Plugin
- [@telnyx/opencode on npm](https://www.npmjs.com/package/@telnyx/opencode)
- Source: `team-telnyx/ai` repo, `plugins/opencode` directory
- Run `opencode auth list` to verify your Telnyx credential is stored
- Use the `/telnyx` TUI command to manage enabled models

### MCP & Other
- [MCP Specification](https://modelcontextprotocol.io/)
- [Telnyx Voice AI API Docs](https://developers.telnyx.com/docs/voice/ai-assistants)
- [Cloud Storage (S3-compatible)](https://developers.telnyx.com/docs/cloud-storage/quick-start)

### Getting Help
- Reach out to Stephen with any questions
- No question is too small — we want you to succeed!
- Feel free to ask about API quirks, best practices, or technical advice

### Sample Code & Examples
- Check out our AI Assistant examples for starter code
- MCP server examples available in the MCP documentation
- Edge Function examples in the Edge Compute docs

---

## Submission Requirements

Before demo day, please provide:
- GitHub repository with your complete solution
- Live Edge Function URL(s) for testing
- Phone number for testing your assistant
- README.md with setup instructions, architecture overview, **and your observability/debugging story**
- Brief demo script outlining what you'll show us
- Your `opencode.jsonc` or `opencode.json` config showing the Telnyx plugin active

---

## Timeline

- **Week to build**: Full week from when you receive this challenge
- **Questions welcome**: Reach out to Stephen anytime during development
- **Demo day**: Schedule with Stephen toward the end of the week

---

## Pro Tips

- **Start simple, then iterate** — Get a basic assistant with a 2-node workflow working first, then add complexity
- **Think about conversation flow** — Voice UX is different from web/mobile UX; workflows make structure explicit
- **Pick the right primitive** — Don't use a Stateful Actor where a KV value suffices. Actors are for single-threaded per-entity state that needs read-modify-write safety
- **Instrument as you go** — Adding structured logs at the start takes minutes; adding them after something breaks takes hours and produces guesses instead of evidence
- **Test early and often** — Actually call your assistant and walk through every workflow path
- **Test every workflow path** — Happy path, fallback path, escalation path, and at least one negative case for every important node
- **Use speak nodes for compliance** — Any message that must be delivered verbatim (disclosures, legal statements) should be a speak node, not a prompt node
- **Scope tools per node** — A node with fewer tools is more reliable; the model has fewer choices and calls the right tool more consistently
- **Document your decisions** — We love hearing about your thought process, especially why you chose Actor vs. KV vs. plain function logic
- **Dogfood intentionally** — Using Telnyx Inference for your coding is the point. Note what works well and what doesn't
- **Have fun with it** — This is your chance to build something cool with the newest Telnyx products!

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Caller (Phone)                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Telnyx AI Assistant                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │            Conversation Workflow                     │    │
│  │  Greeting (speak) → Identify Intent (prompt)         │    │
│  │      ├── Answer FAQ (prompt)                         │    │
│  │      ├── Collect Details (prompt)                    │    │
│  │      └── Escalate (prompt)                            │    │
│  └─────────────────────────────────────────────────────┘    │
│           │                  │                │               │
│     Dynamic Vars         MCP Tools      Workflow Routing     │
└───────────┼──────────────────┼────────────────┼─────────────┘
            │                  │                │
            ▼                  ▼                ▼
┌───────────────────┐  ┌──────────────┐  ┌──────────────────┐
│   Edge Function   │  │  MCP Server  │  │  (LLM conditions │
│   (Webhook)       │  │  (Custom)    │  │   evaluated by   │
│                   │  │              │  │   Telnyx runtime │
│  ┌─────┐ ┌─────┐ │  └──────────────┘  └──────────────────┘
│  │ KV  │ │Actor│ │
│  │     │ │     │ │      ┌─────────────────────┐
│  └─────┘ └─────┘ │      │  Logs / Metrics     │
└───────────────────┘      │  (your evidence)    │
                           └─────────────────────┘

Built using:
┌─────────────────────────────────────────────────────────────┐
│            OpenCode + @telnyx/opencode plugin               │
│    Powered by Telnyx Inference (current model list)          │
└─────────────────────────────────────────────────────────────┘
```

---

Ready to Build?

We're genuinely excited to see what you create with the newest Telnyx Edge Compute and AI products. This challenge is designed to be both fun and representative of the kind of problems you'd tackle working with our platform — building stateful, multi-step AI voice experiences on edge infrastructure, and operating what you ship.

Remember: we're not just evaluating the final product, but also your problem-solving approach, technical decisions, and ability to work with new technologies — including choosing the right primitive for each job and knowing what your systems are doing.

Questions? Reach out to Stephen anytime — stephenm@telnyx.com

Happy coding!
