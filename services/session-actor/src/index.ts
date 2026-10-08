/**
 * HTTP facade for the CallerSession and MetricsCounter Stateful Actors.
 *
 * Telnyx Stateful Actors are TypeScript-only and have no native HTTP surface,
 * so the calling services (webhook in Python, mcp-server in TypeScript) reach the actor through this
 * Edge Function. The default export `worker.fetch(req, env)` is the Worker
 * entry point the Edge runtime invokes on every request — and what the unit
 * tests import as `worker` and call directly.
 *
 * Route contract (mirrors the Python `ActorClient.call` URL shape):
 *
 *     POST /actors/{callerId}/{method}      body: JSON object
 *     → 200 JSON actor method result
 *     → 400 {error} bad caller id / unknown method / actor input error
 *     → 401 {error} bad/missing bearer token
 *     → 404 {error} path does not match the route shape
 *
 *     POST /metrics/{add|snapshot|reset}   body: {counts, latency} for add
 *     → shared "global" MetricsCounter (same bearer token)
 *
 * Security (DECISIONS #8 — least privilege):
 *   - Bearer `INTERNAL_API_TOKEN` read through `env.SECRETS` (cached per
 *     process; Edge pods scale to zero). Never compared with `===` against
 *     a hardcoded value.
 *   - Caller id must be digits only — matches `entity_id` from
 *     `shared/common.py` (phones stripped to digits) and the platform rule
 *     "actor names cannot contain '+'".
 *   - `<method>` must be in a static allowlist — the public surface is
 *     exactly the actor methods this service intends to expose.
 *
 * Auth precedes entity/method validation: an unauthenticated caller
 * receives `401` and learns nothing about routing.
 *
 * Run tests:  cd services/session-actor && npm test
 */

import { log, traceContext } from "./log.js";
import type {
  ActorNamespace,
  CloudStorageBucket,
  Secrets,
} from "@telnyx/edge-runtime";
import {
  CallerSession,
  ActorInputError,
  slotFor,
} from "./caller-session";
import type { SaveDealConfig } from "./caller-session";

// Re-export the actor class so the Edge bundler ships it with the function —
// the [[actors]].type entry must be reachable from the bundle.
export { CallerSession } from "./caller-session";
export { MetricsCounter } from "./metrics-counter";
export { AuditLog } from "./audit-log";
import type { MetricsCounter } from "./metrics-counter";
import type { AuditLog } from "./audit-log";

// --------------------------------------------------------------- public API

/** Public actor methods exposed over HTTP — least privilege method allowlist. */
const ALLOWED_METHODS = [
  "recordCall",
  "getProfile",
  "setLastResults",
  "saveDeal",
  "getSaved",
  "getHistory",
] as const;
type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/** Shape we need on the actor stub. The real stub from
 * `env.CALLER_SESSION.idFromName(name)` is `ActorStub & PublicMethods<CallerSession>`,
 * which is structurally compatible. Tests pass a bare `CallerSession`
 * instance, which is too — the methods resolve on the prototype. */
type CallerSessionStub = Pick<
  CallerSession,
  | "recordCall"
  | "getProfile"
  | "setLastResults"
  | "saveDeal"
  | "getSaved"
  | "getHistory"
>;

/** Bindings environment — declared by `telnyx.toml` (`[[actors]]`,
 * `[[secrets]]`, `[storage.cloudstorage.ITINERARIES]`). The runtime-generated
 * `telnyx-env.d.ts` would augment the base `Env`; we declare the minimal
 * hand-written form here so the code also compiles without codegen. */
interface Env {
  /** Binding declared in telnyx.toml `[[actors]]` (binding = "CALLER_SESSION").
   * `idFromName(name).<method>(args)` invokes the actor — Telnyx serializes
   * on (type, name), giving us effective ACID per caller. */
  CALLER_SESSION: ActorNamespace<CallerSession>;
  /** Shared metrics actor (binding = "METRICS"), one instance named "global". */
  METRICS?: ActorNamespace<MetricsCounter>;
  /** Singleton audit-log actor (binding = "AUDIT_LOG"), one instance named
   * "global". CallerSession sends audit events here via `env.AUDIT_LOG`. */
  AUDIT_LOG?: ActorNamespace<AuditLog>;
  /** Cloud Storage bucket (binding = "ITINERARIES") holding the itinerary
   * HTML pages the actor writes on `saveDeal`. Held by `CallerSession`
   * too; here it serves the public `GET /itineraries/<slot>-<token>.html` route. */
  ITINERARIES?: CloudStorageBucket;
  /** Edge secrets declared via `[[secrets]]`. Used to fetch
   * `INTERNAL_API_TOKEN` through Dapr. */
  SECRETS?: Secrets & { get(handle: string): Promise<string | undefined> };
  /** Direct injection (tests / local dev) — skips the Dapr round-trip. */
  INTERNAL_API_TOKEN?: string;
}

/** POST /metrics/{add|snapshot|reset} on the shared "global" MetricsCounter. */
async function metrics(req: Request, env: Env, op: string): Promise<Response> {
  if (!env.METRICS) return error(404, "metrics not configured");
  const stub = env.METRICS.idFromName("global") as unknown as Pick<MetricsCounter, "add" | "snapshot" | "reset">;
  try {
    if (op === "snapshot") return json(200, await stub.snapshot());
    if (op === "reset") return json(200, await stub.reset());
    const body = (await req.json().catch(() => ({}))) as { counts?: unknown; latency?: unknown };
    return json(200, await stub.add(body));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("ERROR", "metrics_failed", { op, error: msg });
    return json(/ActorInputError/.test(msg) ? 400 : 500, { error: "metrics update failed" });
  }
}

/** Constant-time string compare, so response timing does not leak the token. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Default Worker export. `worker.fetch(req, env)` is the Edge entry point;
 * tests import this object as `worker` and call `worker.fetch(request, env)`.
 * Each request runs in its own trace context (the caller's x-trace-id).
 */
export default {
  /** One `actor.request` latency span per request, then route it. */
  async fetch(req: Request, env: Env): Promise<Response> {
    const trace = req.headers.get(process.env.TRACE_HEADER ?? "x-trace-id") ?? "";
    return traceContext.run({ id: trace }, () => handle(req, env));
  },
};

async function handle(req: Request, env: Env): Promise<Response> {
  {
    const started = Date.now();
    const resp = await route(req, env);
    const [, entity = "", method = ""] =
      new URL(req.url).pathname.match(/^\/actors\/([^/]+)\/([^/]+)$/) ?? [];
    const op = method || new URL(req.url).pathname; // e.g. "/metrics/add"
    log("INFO", "actor.request", { entity, method: op, status: resp.status, duration_ms: Date.now() - started });
    return resp;
  }
}

async function route(req: Request, env: Env): Promise<Response> {
  {
    const pathname = new URL(req.url).pathname;

    // Public GET route for itinerary HTML files. The URL is
    // `/itineraries/<slot>-<token>.html`: the slot (0..ITINERARY_SLOTS-1) is
    // the fixed key the caller maps to, and the token (one per caller,
    // minted on the first save and reused on every later save — step 22b)
    // is the capability. No bearer token required (AGENTS.md step 22):
    // the slot part is validated against the range, and the facade serves
    // the object only when the token stored in the HTML matches.
    if (req.method === "GET" && pathname.startsWith("/itineraries/")) {
      const m = pathname.match(
        /^\/itineraries\/(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.html$/i,
      );
      if (!m) return error(404, "not found");
      return serveItinerary(env, Number(m[1]), m[2].toLowerCase());
    }

    // Only POST is used by the actor facade.
    if (req.method !== "POST") {
      return error(405, `method ${req.method} not allowed`);
    }

    // Path must be POST /actors/{entity}/{method} or POST /metrics/{op}.
    const metricsOp = pathname.match(/^\/metrics\/(add|snapshot|reset)$/)?.[1];
    const match = pathname.match(/^\/actors\/([^/]+)\/([^/]+)$/);
    if (!match && !metricsOp) return error(404, "not found");

    // Auth first — never leak routing reasons to an unauthenticated caller.
    const expectedToken = await internalTokenFor(env);
    if (
      !expectedToken ||
      !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${expectedToken}`)
    ) {
      return error(401, "unauthorized");
    }

    if (metricsOp) return await metrics(req, env, metricsOp);
    if (!match) return error(404, "not found");
    const [, entityRaw, methodName] = match;

    // Decode after auth: a malformed escape ("%E0") is a 400, not a crash.
    let entity: string;
    try {
      entity = decodeURIComponent(entityRaw ?? "");
    } catch {
      return error(400, "invalid actor id");
    }

    // Entity id must be digits only — matches `entity_id` from common.py
    // (phones stripped to digits) and the rule "actor names cannot contain '+'".
    if (!/^\d+$/.test(entity)) return error(400, "invalid actor id");

    // Method must be in the allowlist.
    if (!ALLOWED_METHODS.includes(methodName as AllowedMethod)) {
      return error(400, `method ${methodName} not exposed`);
    }
    const method = methodName as AllowedMethod;

    // Parse the body. The Python `ActorClient` posts JSON; tests post JSON
    // without a content-type, so we try JSON unconditionally ({} if empty).
    let body: unknown = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return error(400, `invalid json body: ${msg}`);
    }

    // Resolve the actor stub and dispatch.
    try {
      const stub = env.CALLER_SESSION.idFromName(entity) as CallerSessionStub;
      const result = await dispatch(stub, method, body);
      return json(200, result ?? {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ActorInputError) {
        // Validation/parsing failure from the actor — caller's fault.
        return json(400, { error: msg });
      }
      // On Telnyx Edge the actor runs behind an RPC hop, so its ActorInputError
      // arrives here as a plain Error whose text embeds the original
      // {"name":"ActorInputError","message":"..."}. Recover it as a 400.
      const remote = /"message":"([^"]*)","name":"ActorInputError"/.exec(msg);
      if (remote) return json(400, { error: remote[1] });
      // Unexpected failure — log with stack, return 500 (server's fault).
      log("ERROR", "dispatch_failed", {
        entity,
        method,
        error: msg,
        stack: e instanceof Error ? e.stack : undefined,
      });
      return json(500, { error: "actor call failed" });
    }
  }
}

/**
 * Dispatch to the actor method by name. Each method receives the body the
 * caller posted; `recordCall` / `getProfile` / `getSaved` ignore theirs.
 */
async function dispatch(
  stub: CallerSessionStub,
  method: AllowedMethod,
  body: unknown,
): Promise<unknown> {
  switch (method) {
    case "recordCall":
      return await stub.recordCall();
    case "getProfile":
      return await stub.getProfile();
    case "getSaved":
      return await stub.getSaved();
    case "getHistory":
      return await stub.getHistory();
    case "setLastResults":
      return await stub.setLastResults(
        (body ?? {}) as { deals: unknown; query?: unknown; conversationId?: unknown },
      );
    case "saveDeal":
      return await stub.saveDeal(
        (body ?? {}) as { dealId?: string; config?: SaveDealConfig; conversationId?: unknown },
      );
  }
}

/**
 * Resolve the `INTERNAL_API_TOKEN`.
 *
 * Order: `env.INTERNAL_API_TOKEN` first (tests / local dev), then
 * `env.SECRETS.get("INTERNAL_API_TOKEN")` (Dapr-backed in production).
 * Successful reads are cached per-process — Edge pods scale to zero, so
 * the cache lives for one pod's lifetime and never goes stale. A failed read
 * is not cached so a transient Dapr blip self-heals on retry.
 */
let cachedToken: string | null | undefined = undefined;
async function internalTokenFor(env: Env): Promise<string | undefined> {
  if (env.INTERNAL_API_TOKEN) return env.INTERNAL_API_TOKEN;
  if (cachedToken !== undefined) return cachedToken ?? undefined;
  try {
    const value = env.SECRETS ? await env.SECRETS.get("INTERNAL_API_TOKEN") : undefined;
    cachedToken = value ?? null;
    return value;
  } catch (e) {
    log("ERROR", "secret_read_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Serve one itinerary HTML file from `env.ITINERARIES` to the public
 * `GET /itineraries/<slot>-<token>.html` route. The slot (fixed key
 * `itineraries/slot-<slot>.html`) is the fixed key the caller maps to;
 * the token (one per caller, minted on the first save and reused on every
 * later save — step 22b) is the capability. The facade reads the object
 * body, extracts the stored token from the leading `<!-- token:... -->`
 * comment, and serves the file ONLY when the URL token matches —
 * otherwise 404. So an old link whose slot was overwritten by another
 * caller returns 404 and never shows someone else's trip (step 22). No
 * bearer: the token is the capability.
 */
async function serveItinerary(
  env: Env,
  slot: number,
  token: string,
): Promise<Response> {
  const bucket = env.ITINERARIES;
  if (!bucket) return error(404, "not found");
  // Validate the slot range (matches the actor's resolveSlots guard).
  const slots = resolveFacadeSlots();
  if (slot < 0 || slot >= slots) return error(404, "not found");
  const key = `itineraries/slot-${slot}.html`;
  try {
    const obj = await bucket.get(key);
    if (!obj || !("body" in obj)) return error(404, "not found");
    // `obj` is now CloudStorageObjectBody (has body, text(), writeHttpMetadata).
    const bodyText = await obj.text();
    const tm = bodyText.match(
      /^<!-- token:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) -->/,
    );
    if (!tm || tm[1] !== token) return error(404, "not found");
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    return new Response(bodyText, { status: 200, headers });
  } catch (e) {
    log("ERROR", "itinerary.read_failed", {
      key,
      error: e instanceof Error ? e.message : String(e),
    });
    return error(500, "itinerary read failed");
  }
}

/** Resolved number of itinerary slots for the facade route validation.
 * Reads `process.env.ITINERARY_SLOTS` (default 4) and clamps against
 * `STORAGE_MAX_OBJECTS` (default 5) — same guard as the actor's
 * `resolveSlots`, but without the `cfg` override (the facade reads its own
 * env vars, which ARE honoured since it is a function, not an actor). */
function resolveFacadeSlots(): number {
  let slots = pickFacadeInt("ITINERARY_SLOTS", DEFAULT_SLOTS);
  const maxObjects = pickFacadeInt("STORAGE_MAX_OBJECTS", DEFAULT_MAX_OBJECTS);
  if (slots + 1 > maxObjects) {
    log("ERROR", "config.clamp_slots", {
      requested: slots,
      maxObjects,
      clamped: Math.max(0, maxObjects - 1),
    });
    slots = Math.max(0, maxObjects - 1);
  }
  return slots;
}

/** Read a positive int env var for the facade (default `def`). */
function pickFacadeInt(name: string, def: number): number {
  const v = process.env[name];
  if (typeof v === "string") {
    const s = v.trim();
    if (s) {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return def;
}

const DEFAULT_SLOTS = 4;
const DEFAULT_MAX_OBJECTS = 5;

/** JSON response body. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Standard `{error: message}` JSON response — uniform shape across all
 * error paths so callers only need to parse one envelope. */
function error(status: number, message: string): Response {
  return json(status, { error: message });
}
