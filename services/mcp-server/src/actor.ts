/**
 * src/actor.ts — clients for the session-actor Stateful Actor.
 *
 * Two implementations of the same `Actor` interface:
 *
 *   - `ActorClient` — HTTP client for the TypeScript session-actor facade at
 *     `ACTOR_SERVICE_URL`. Used by the Python webhook (Python Edge functions
 *     cannot bind actors), and selectable from `index.ts` by setting
 *     `USE_SHARED_ACTOR=false`. POSTs JSON to `/actors/{entity_id}/{method}`
 *     with a Bearer `INTERNAL_API_TOKEN` and the current `x-trace-id`
 *     (configurable via `TRACE_HEADER`). 4xx → `ActorInputError` (the caller
 *     passed bad arguments), 5xx / network → `ActorError` (transient).
 *
 *   - `EdgeActor` — calls the shared `CallerSession` actor directly through
 *     the `env.SESSIONS` binding (Telnyx "shared actors": the `fde-session-actor`
 *     function owns the class; this function declares the same `type` under
 *     the SESSIONS binding and ships no class code). The default path for
 *     `index.ts` (`USE_SHARED_ACTOR=true`, the production default). Over the
 *     RPC hop an actor `ActorInputError` arrives as a plain Error whose
 *     message embeds `{"name":"ActorInputError"}` — this is mapped back to the
 *     MCP `ActorInputError`, anything else to `ActorError`.
 *
 * Mirrors `shared/common.py`'s `ActorClient`. Dependencies (the fetch impl for
 * `ActorClient`) are injected so tests pass a fake.
 */

import { env } from "@telnyx/edge-runtime";

import { config } from "./config.js";
import { getTraceId } from "./log.js";

/** Any failure calling the session-actor facade. */
export class ActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorError";
  }
}

/** A 4xx rejection — the caller passed bad arguments to the actor. */
export class ActorInputError extends ActorError {
  constructor(message: string) {
    super(message);
    this.name = "ActorInputError";
  }
}

/** Minimal actor surface the MCP server needs. The real `ActorClient`
 * implements it; tests pass a `FakeActor` with the same shape. */
export interface Actor {
  call(entityId: string, method: string, body?: unknown): Promise<unknown>;
}

/** HTTP client for the TypeScript session-actor facade. */
export class ActorClient implements Actor {
  private readonly base: string;
  private readonly token: string;
  private readonly traceHeader: string;

  constructor(private readonly fetchImpl: typeof fetch) {
    this.base = config.require("ACTOR_SERVICE_URL").replace(/\/+$/, "");
    this.token = config.require("INTERNAL_API_TOKEN");
    this.traceHeader = config.optional("TRACE_HEADER", "x-trace-id");
  }

  /** Call an actor method by entity id. Throws on 4xx/5xx/network. */
  async call(entityId: string, method: string, body: unknown = {}): Promise<unknown> {
    const url = `${this.base}/actors/${entityId}/${method}`;
    const headers = new Headers({
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      [this.traceHeader]: getTraceId(),
    });
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(config.integer("HTTP_TIMEOUT_MS", 3000)),
      });
    } catch (e) {
      throw new ActorError(`actor ${entityId}/${method}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Only 400/409/422 are the caller's input (e.g. "deal not in the last search
    // results"); auth/routing errors (401/403/404/405) and 5xx mean the service
    // is unusable. ActorError messages are logged, never shown to the model.
    if (resp.status >= 500 || ![400, 409, 422].includes(resp.status) && resp.status >= 400) {
      throw new ActorError(`actor ${entityId}/${method} returned ${resp.status}`);
    }
    if (resp.status >= 400) {
      let msg = `HTTP ${resp.status}`;
      try {
        const j = (await resp.json()) as { error?: string };
        if (j && typeof j.error === "string" && j.error.length > 0) msg = j.error;
      } catch {
        // fall back to status text below
      }
      if (msg.startsWith("HTTP ")) {
        try {
          const text = await resp.text();
          if (text && text.length > 0) msg = text;
        } catch {
          /* keep status fallback */
        }
      }
      // The actor's own reason only: no phone number or method name reaches the model.
      throw new ActorInputError(msg);
    }
    return await resp.json();
  }
}

/** Service-wide metrics sink: the shared MetricsCounter actor behind the facade's
 * POST /metrics/add. Fire-and-forget — a metrics failure never affects a call. */
export interface Metrics {
  add(counts: Record<string, number>, latency?: Record<string, number>): void;
}

export class ActorMetrics implements Metrics {
  private readonly url: string;
  private readonly token: string;

  constructor(private readonly fetchImpl: typeof fetch) {
    this.url = `${config.require("ACTOR_SERVICE_URL").replace(/\/+$/, "")}/metrics/add`;
    this.token = config.require("INTERNAL_API_TOKEN");
  }

  add(counts: Record<string, number>, latency: Record<string, number> = {}): void {
    void this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ counts, latency }),
    }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- EdgeActor

/**
 * Minimal hand-written shape for the `SESSIONS` actor binding declared in
 * `func.toml` as `[[actors]] binding = "SESSIONS" type = "CallerSession"`.
 *
 * We deliberately do NOT import the `CallerSession` class from
 * `services/session-actor`: this function ships no actor code. The Edge
 * runtime resolves the shared actor over an RPC hop to the `fde-session-actor`
 * function that owns the class. The base `ActorNamespace` (no type argument)
 * resolves `PublicMethods` to `{}` — exactly the untyped
 * `{ id, fetch, [method]: unknown }` stub we need here (see bindings.d.ts).
 */
interface SessionsNamespace {
  /** Materialise the actor stub for `name`. Same name always → same instance. */
  idFromName(name: string): {
    readonly id: string;
    [method: string]: unknown;
  };
}

/**
 * `Actor` client that talks to the shared `CallerSession` actor directly
 * through the `env.SESSIONS` Edge binding (Telnyx "shared actors") — the
 * production default for the MCP server (`USE_SHARED_ACTOR=true`).
 *
 * Unlike `ActorClient`, there is no HTTP hop and no bearer token: the
 * `[[actors]]` binding is the trust boundary. The actor's own `ActorInputError`
 * (e.g. "deal not in the last search results") is recovered from the RPC
 * envelope's embedded `{"name":"ActorInputError"}` marker and re-thrown as
 * the MCP `ActorInputError` so `callActor` can pass it through unchanged;
 * any other failure is wrapped as a transient `ActorError`.
 */
export class EdgeActor implements Actor {
  private readonly sessions: SessionsNamespace;

  constructor() {
    const binding = (env as unknown as { SESSIONS?: SessionsNamespace }).SESSIONS;
    if (!binding) {
      // Fail fast at boot: the function is misconfigured. The fix is to add
      // `[[actors]] binding = "SESSIONS" type = "CallerSession"` to func.toml,
      // or to set `USE_SHARED_ACTOR=false` and fall back to `ActorClient`.
      throw new Error(
        'env.SESSIONS is not bound: add `[[actors]] binding = "SESSIONS" type = "CallerSession"` to func.toml',
      );
    }
    this.sessions = binding;
  }

  /** Call an actor method by entity id. Throws on input/transient failures. */
  async call(entityId: string, method: string, body: unknown = {}): Promise<unknown> {
    let stub: ReturnType<SessionsNamespace["idFromName"]>;
    try {
      stub = this.sessions.idFromName(entityId);
    } catch (e) {
      throw new ActorError(
        `actor ${entityId}/${method}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const fn = stub[method] as ((body?: unknown) => Promise<unknown>) | undefined;
    if (typeof fn !== "function") {
      // The actor class (owned by fde-session-actor) does not expose a method
      // with this name. Treat as a server fault — the MCP allowlist should
      // have caught it earlier.
      throw new ActorError(`actor ${entityId}/${method}: method not exposed`);
    }
    try {
      return await fn.call(stub, body);
    } catch (e) {
      // Over the RPC hop an `ActorInputError` arrives as a plain Error whose
      // message embeds the original `{"name":"ActorInputError","message":...}`
      // (the actor's own reason — e.g. "deal tlv-lca-1 not in last search
      // results"). Recover it so `callActor` maps it to a caller-safe
      // ToolError; anything else is a transient actor failure.
      if (e instanceof ActorInputError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/"name":"ActorInputError"/.test(msg)) {
        const m = /"message":"([^"]*)"/.exec(msg);
        throw new ActorInputError(m ? m[1] : msg);
      }
      throw new ActorError(`actor ${entityId}/${method}: ${msg}`);
    }
  }
}
