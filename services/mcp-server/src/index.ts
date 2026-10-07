/**
 * src/index.ts — production entry: a `node:http` server on the Edge.
 *
 * Wires the real Telnyx clients (`EdgeKv`, the platform `fetch`) and serves
 * the handler from `createHandler` (auth + health + MCP). A simple
 * health probe lives at `GET /health` so the Edge can liveness-check the
 * function without going through the MCP bearer auth.
 *
 * Two actor clients implement the `Actor` interface used by `createHandler`:
 *
 *   - `EdgeActor` (default, `USE_SHARED_ACTOR=true`) — calls the shared
 *     `CallerSession` actor directly through the `env.SESSIONS` binding
 *     (Telnyx "shared actors": the `fde-session-actor` function owns the
 *     class, this function declares the same `type` and ships no class code).
 *     No HTTP hop, no bearer — the binding is the trust boundary.
 *   - `ActorClient` (`USE_SHARED_ACTOR=false`) — HTTP client for the
 *     session-actor facade at `ACTOR_SERVICE_URL`. Stays for the Python
 *     webhook, which cannot bind actors, and useful for local debugging.
 *
 * Both share the same `Actor` surface, so `createHandler` is agnostic.
 *
 * Edge loads this module as the function entry; in local development
 * (`npm start`) it listens on `process.env.PORT || 8080`. The listen is
 * guarded so importing the module (tests do not import this file) does not
 * start a server — only running it directly does.
 *
 * Deploy:  telnyx-edge ship --from-dir services/mcp-server
 */

import http from "node:http";

import { info, warning } from "./log.js";
import { ActorClient, ActorMetrics, EdgeActor } from "./actor.js";
import { config } from "./config.js";
import { EdgeKv } from "./kv.js";
import { createHandler } from "./server.js";
import { TelnyxSms } from "./sms.js";

/** Build the production dependencies from Edge config / secrets. */
function buildDependencies() {
  // `USE_SHARED_ACTOR` (default true) selects the direct actor binding over
  // the HTTP facade hop. The Python webhook has no equivalent — Python Edge
  // functions cannot bind actors — so `ActorClient` remains for it.
  const useShared = config.flag("USE_SHARED_ACTOR", true);
  const actor = useShared ? new EdgeActor() : new ActorClient(fetch);
  if (!useShared) {
    warning("mcp.actor.http_fallback", { reason: "USE_SHARED_ACTOR=false" });
  }
  return {
    kv: new EdgeKv(),
    actor,
    fetchImpl: fetch,
    sms: new TelnyxSms(),
    metrics: new ActorMetrics(fetch),
  };
}

/** Create the HTTP server (separate so it is reusable / testable). */
function createHttpServer(): http.Server {
  const handler = createHandler(buildDependencies());
  return http.createServer((req, res) => handler(req, res));
}

// Always listen, as the official Telnyx TS scaffold does: Edge starts this
// file with `npm start` (node dist/index.js). Tests import server.ts, never
// this file, so no guard is needed.
const port = Number(process.env.PORT ?? 8080);
createHttpServer().listen(port, () => {
  info("mcp.listening", { port });
});
