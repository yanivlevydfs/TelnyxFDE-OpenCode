/**
 * HTTP facade for the CallerSession Stateful Actor.
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

import { localIso } from "./time.js";
import type { ActorNamespace, Secrets } from "@telnyx/edge-runtime";
import {
  CallerSession,
  ActorInputError,
} from "./caller-session";

// Re-export the actor class so the Edge bundler ships it with the function —
// the [[actors]].type entry must be reachable from the bundle.
export { CallerSession } from "./caller-session";

// --------------------------------------------------------------- public API

/** Public actor methods exposed over HTTP — least privilege method allowlist. */
const ALLOWED_METHODS = [
  "recordCall",
  "getProfile",
  "setLastResults",
  "saveDeal",
  "getSaved",
] as const;
type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/** Shape we need on the actor stub. The real stub from
 * `env.CALLER_SESSION.idFromName(name)` is `ActorStub & PublicMethods<CallerSession>`,
 * which is structurally compatible. Tests pass a bare `CallerSession`
 * instance, which is too — the methods resolve on the prototype. */
type CallerSessionStub = Pick<
  CallerSession,
  "recordCall" | "getProfile" | "setLastResults" | "saveDeal" | "getSaved"
>;

/** Bindings environment — declared by `telnyx.toml` (`[[actors]]`,
 * `[[secrets]]`). The runtime-generated `telnyx-env.d.ts` would augment the
 * base `Env`; we declare the minimal hand-written form here so the code also
 * compiles without codegen. */
interface Env {
  /** Binding declared in telnyx.toml `[[actors]]` (binding = "CALLER_SESSION").
   * `idFromName(name).<method>(args)` invokes the actor — Telnyx serializes
   * on (type, name), giving us effective ACID per caller. */
  CALLER_SESSION: ActorNamespace<CallerSession>;
  /** Edge secrets declared via `[[secrets]]`. Used to fetch
   * `INTERNAL_API_TOKEN` through Dapr. */
  SECRETS?: Secrets & { get(handle: string): Promise<string | undefined> };
  /** Direct injection (tests / local dev) — skips the Dapr round-trip. */
  INTERNAL_API_TOKEN?: string;
}

/**
 * Default Worker export. `worker.fetch(req, env)` is the Edge entry point;
 * tests import this object as `worker` and call `worker.fetch(request, env)`.
 */
/** Constant-time string compare, so response timing does not leak the token. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Trace id of the request being handled (from the caller's x-trace-id header),
// added to every facade log line so one call can be followed across services.
let currentTrace = "";

export default {
  /** One `actor.request` latency span per request, then route it. */
  async fetch(req: Request, env: Env): Promise<Response> {
    currentTrace = req.headers.get(process.env.TRACE_HEADER ?? "x-trace-id") ?? "";
    const started = Date.now();
    const resp = await route(req, env);
    const [, entity = "", method = ""] =
      new URL(req.url).pathname.match(/^\/actors\/([^/]+)\/([^/]+)$/) ?? [];
    log("INFO", "actor.request", { entity, method, status: resp.status, duration_ms: Date.now() - started });
    return resp;
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  {
    // Only POST is used by the actor facade.
    if (req.method !== "POST") {
      return error(405, `method ${req.method} not allowed`);
    }

    // Path must be POST /actors/{entity}/{method}.
    const match = new URL(req.url).pathname.match(/^\/actors\/([^/]+)\/([^/]+)$/);
    if (!match) return error(404, "not found");

    const [, entityRaw, methodName] = match;

    // Auth first — never leak routing reasons to an unauthenticated caller.
    const expectedToken = await internalTokenFor(env);
    if (
      !expectedToken ||
      !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${expectedToken}`)
    ) {
      return error(401, "unauthorized");
    }

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
      return json(500, { error: msg });
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
    case "setLastResults":
      return await stub.setLastResults((body ?? {}) as { deals: unknown });
    case "saveDeal":
      return await stub.saveDeal((body ?? {}) as { dealId?: string });
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

// ----------------------------------------------------------------- logging

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";
const LEVELS: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};
let logLevel: Level = "INFO";
{
  const envLevel = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  if (envLevel in LEVELS) logLevel = envLevel as Level;
}

function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const line = JSON.stringify({
    ts: localIso(),
    level,
    service: "session-actor",
    event,
    trace_id: currentTrace,
    ...fields,
    // Caller ids are phone digits: log the last 4 only.
    ...(typeof fields.entity === "string" ? { entity: `***${fields.entity.slice(-4)}` } : {}),
  });
  if (level === "ERROR") console.error(line);
  else if (level === "WARNING") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------- helpers

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
