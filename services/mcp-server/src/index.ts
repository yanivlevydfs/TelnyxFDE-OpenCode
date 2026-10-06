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

import { info } from "./log";
import { ActorClient } from "./actor";
import { EdgeKv } from "./kv";
import { createHandler } from "./server";

/** Build the production dependencies from Edge config / secrets. */
function buildDependencies() {
  return {
    kv: new EdgeKv(),
    actor: new ActorClient(fetch),
    fetchImpl: fetch,
  };
}

/** Create the HTTP server (separate so it is reusable / testable). */
function createHttpServer(): http.Server {
  const handler = createHandler(buildDependencies());
  return http.createServer((req, res) => handler(req, res));
}

// Only listen when run directly (Edge invokes the bundled module; local dev
// runs `node dist/index.js`). Guards against tests/importers accidentally
// binding the port.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  createHttpServer().listen(port, () => {
    info("mcp.listening", { port });
  });
}
