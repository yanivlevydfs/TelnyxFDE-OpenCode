/**
 * src/index.ts — production entry: a `node:http` server on the Edge.
 *
 * Wires the real Telnyx clients (`EdgeKv`, `ActorClient`, the platform `fetch`)
 * and serves the handler from `createHandler` (auth + health + MCP). A simple
 * health probe lives at `GET /health` so the Edge can liveness-check the
 * function without going through the MCP bearer auth.
 *
 * Edge loads this module as the function entry; in local development
 * (`npm start`) it listens on `process.env.PORT || 8080`. The listen is
 * guarded so importing the module (tests do not import this file) does not
 * start a server — only running it directly does.
 *
 * Deploy:  telnyx-edge ship --from-dir services/mcp-server
 */

import http from "node:http";

import { info } from "./log.js";
import { ActorClient, ActorMetrics } from "./actor.js";
import { EdgeKv } from "./kv.js";
import { createHandler } from "./server.js";
import { TelnyxSms } from "./sms.js";

/** Build the production dependencies from Edge config / secrets. */
function buildDependencies() {
  return {
    kv: new EdgeKv(),
    actor: new ActorClient(fetch),
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
