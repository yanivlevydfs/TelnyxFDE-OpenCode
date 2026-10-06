/**
 * src/actor.ts — HTTP client for the TypeScript session-actor facade.
 *
 * POSTs JSON to `${ACTOR_SERVICE_URL}/actors/{entity_id}/{method}` with a
 * Bearer `INTERNAL_API_TOKEN` and the current `x-trace-id` (configurable via
 * `TRACE_HEADER`). Returns the parsed JSON body. 4xx → `ActorInputError` (the
 * caller passed bad arguments), 5xx / network → `ActorError` (transient).
 *
 * Mirrors `shared/common.py`'s `ActorClient`; dependencies (the fetch impl)
 * are injected so tests pass a fake.
 */

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
