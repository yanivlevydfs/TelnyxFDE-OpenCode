/**
 * Unit tests for the TypeScript MCP server (services/mcp-server/src/server.ts),
 * ported 1:1 from tests/test_mcp.py (the spec). Uses node:test with fakes
 * for kv / actor / fetch — the real Edge clients are exercised only in
 * `index.ts` (production).
 *
 * Run:  cd services/mcp-server && npm test   (node:test via tsx)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  createHandler,
  createServer,
  slim,
  type Kv,
  KvError,
} from "../services/mcp-server/src/server";
import {
  ActorError,
  ActorInputError,
  type Actor,
} from "../services/mcp-server/src/actor";

// Test configuration only — real values come from Telnyx Edge secrets.
// Mirrors tests/conftest.py + the [env_vars] defaults in func.toml. Set
// before any rpc() call; config reads env lazily so import order is fine.
process.env.MCP_API_KEY = "mcp-test";
process.env.FLYTLV_API_KEY = "flytlv-test";
process.env.DEALS_RESULT_LIMIT = "2";

const FLYTLV = {
  currency: "USD",
  count: 3,
  deals: [
    {
      deal_id: "tlv-lca-1",
      price: 64.0,
      departure_date: "2026-11-09",
      return_date: "2026-11-12",
      airline: "Wizz Air",
      is_direct: true,
      deal_url: "https://flytlv.app/go?id=tlv-lca-1",
      destination_airport: { city: "Larnaca", country: "Cyprus" },
    },
    {
      deal_id: "tlv-pmo-1",
      price: 90.0,
      destination_airport: { city: "Palermo", country: "Italy" },
    },
    {
      deal_id: "extra",
      price: 120.0,
      destination_airport: { city: "Athens" },
    },
  ],
};

// ------------------------------------------------------------------- fakes

/** In-memory KV with an optional `fail` flag (mirrors FakeKv in test_mcp.py). */
class FakeKv implements Kv {
  data: Map<string, unknown>;
  fail: boolean;
  constructor(mapped = true, fail = false) {
    this.data = new Map(
      mapped ? ([["session/conv-1", { entity_id: "97250" }]] as [string, unknown][]) : [],
    );
    this.fail = fail;
  }
  async getJson(key: string): Promise<unknown> {
    if (this.fail) throw new KvError("down");
    return this.data.get(key);
  }
  async putJson(key: string, value: unknown): Promise<void> {
    if (this.fail) throw new KvError("down");
    this.data.set(key, value);
  }
}

/** Fake actor facade — records calls; `reject` -> ActorInputError, `fail` -> ActorError. */
class FakeActor implements Actor {
  calls: Array<{ entity: string; method: string; body: unknown }> = [];
  reject: string | null;
  fail: boolean;
  constructor(reject: string | null = null, fail = false) {
    this.reject = reject;
    this.fail = fail;
  }
  async call(entity: string, method: string, body?: unknown): Promise<unknown> {
    this.calls.push({ entity, method, body });
    if (this.reject) throw new ActorInputError(this.reject);
    if (this.fail) throw new ActorError("down");
    return { method, ok: true };
  }
}

/** Fake fetch for flytlv: records the request (url + headers), returns FLYTLV or an error. */
type FlytlvCall = { url: string; headers: Headers };
function flytlvFetch(status = 200, calls: FlytlvCall[] = []): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url, headers });
    const body =
      status === 200 ? JSON.stringify(FLYTLV) : JSON.stringify({ detail: "Not Found" });
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

// ------------------------------------------------------------------- helpers

/** Send one JSON-RPC message to a throwaway http server running `createHandler`
 * built from the given fakes. Returns `{status, body}`. */
async function rpc(
  kv: Kv,
  actor: Actor,
  fetchImpl: typeof fetch,
  method: string,
  params?: unknown,
  token = "mcp-test",
): Promise<{ status: number; body: any }> {
  const handler = createHandler({ kv, actor, fetchImpl });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const body = { jsonrpc: "2.0", id: 1, method, params: params ?? {} };
  const resp = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  await new Promise<void>((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
  return { status: resp.status, body: json };
}

/** A tools/call request envelope with the Telnyx conversation id in _meta. */
function toolCall(name: string, args?: unknown, conversation = "conv-1"): unknown {
  return {
    name,
    arguments: args ?? {},
    _meta: { telnyx_conversation_id: conversation },
  };
}

/** Pull {error, text} out of a tools/call response (mirrors `result()` in Python). */
function result(resp: { status: number; body: any }): {
  error: boolean;
  text: string;
} {
  const out = resp.body.result;
  return { error: Boolean(out.isError), text: out.content[0].text };
}

// -------------------------------------------------------------------- tests

test("wrong token is 401", async () => {
  const resp = await rpc(
    new FakeKv(),
    new FakeActor(),
    flytlvFetch(),
    "tools/list",
    undefined,
    "nope",
  );
  assert.equal(resp.status, 401);
});

test("tools/list has the three tools", async () => {
  const resp = await rpc(new FakeKv(), new FakeActor(), flytlvFetch(), "tools/list");
  const names = new Set(resp.body.result.tools.map((t: { name: string }) => t.name));
  assert.deepEqual(names, new Set(["search_deals", "save_deal", "list_saved_deals"]));
});

test("search_deals calls flytlv, caches and remembers", async () => {
  const kv = new FakeKv();
  const actor = new FakeActor();
  const calls: FlytlvCall[] = [];
  const resp = await rpc(
    kv,
    actor,
    flytlvFetch(200, calls),
    "tools/call",
    toolCall("search_deals", { destination: "lca", direct_only: true }),
  );
  const out = result(resp);
  assert.equal(out.error, false);
  const deals = JSON.parse(out.text).deals;
  assert.deepEqual(
    deals.map((d: { city: string }) => d.city),
    ["Larnaca", "Palermo"], // DEALS_RESULT_LIMIT=2
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("x-api-key"), "flytlv-test");
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get("destination"), "LCA");
  assert.equal(u.searchParams.get("stops"), "0");
  assert.ok(
    Array.from(kv.data.keys()).some((k) => k.startsWith("cache/deals/")),
  );
  assert.equal(actor.calls[0].entity, "97250");
  assert.equal(actor.calls[0].method, "setLastResults");
});

test("search_deals uses the cache on the second call", async () => {
  const kv = new FakeKv();
  const calls: FlytlvCall[] = [];
  const fetchImpl = flytlvFetch(200, calls);
  await rpc(
    kv,
    new FakeActor(),
    fetchImpl,
    "tools/call",
    toolCall("search_deals", { destination: "LCA" }),
  );
  await rpc(
    kv,
    new FakeActor(),
    fetchImpl,
    "tools/call",
    toolCall("search_deals", { destination: "LCA" }),
  );
  assert.equal(calls.length, 1);
});

test("search_deals flytlv 404 is a tool error", async () => {
  const resp = await rpc(
    new FakeKv(),
    new FakeActor(),
    flytlvFetch(404),
    "tools/call",
    toolCall("search_deals"),
  );
  const out = result(resp);
  assert.equal(out.error, true);
  assert.match(out.text, /unavailable/);
});

test("search_deals with KV down is a tool error", async () => {
  // KV down: flytlv still answers, but the caller can't be resolved -> error.
  const resp = await rpc(
    new FakeKv(true, true),
    new FakeActor(),
    flytlvFetch(),
    "tools/call",
    toolCall("search_deals"),
  );
  assert.equal(result(resp).error, true);
});

test("save_deal success and rejection", async () => {
  const ok = await rpc(
    new FakeKv(),
    new FakeActor(),
    flytlvFetch(),
    "tools/call",
    toolCall("save_deal", { deal_id: "tlv-lca-1" }),
  );
  assert.equal(result(ok).error, false);
  const rejected = await rpc(
    new FakeKv(),
    new FakeActor("deal not in the last search results"),
    flytlvFetch(),
    "tools/call",
    toolCall("save_deal", { deal_id: "x" }),
  );
  const out = result(rejected);
  assert.equal(out.error, true);
  assert.match(out.text, /last search/);
});

test("unknown conversation is a tool error", async () => {
  const resp = await rpc(
    new FakeKv(false),
    new FakeActor(),
    flytlvFetch(),
    "tools/call",
    toolCall("list_saved_deals", undefined, "other"),
  );
  const out = result(resp);
  assert.equal(out.error, true);
  assert.match(out.text, /identify this call/);
});

test("actor down is a tool error", async () => {
  const resp = await rpc(
    new FakeKv(),
    new FakeActor(undefined, true),
    flytlvFetch(),
    "tools/call",
    toolCall("list_saved_deals"),
  );
  const out = result(resp);
  assert.equal(out.error, true);
  assert.match(out.text, /unavailable/);
});

test("slim keeps voice fields", () => {
  assert.deepEqual(slim(FLYTLV.deals[0] as never, "USD"), {
    dealId: "tlv-lca-1",
    city: "Larnaca",
    country: "Cyprus",
    price: 64,
    currency: "USD",
    departureDate: "2026-11-09",
    returnDate: "2026-11-12",
    airline: "Wizz Air",
    direct: true,
    url: "https://flytlv.app/go?id=tlv-lca-1",
  });
});

// `createServer` is exercised end-to-end above via rpc; keep a smoke check that
// it returns a server with the three tools registered (guards the export).
test("createServer registers exactly the three tools", async () => {
  const resp = await rpc(
    new FakeKv(),
    new FakeActor(),
    flytlvFetch(),
    "tools/list",
  );
  const names = resp.body.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, ["list_saved_deals", "save_deal", "search_deals"]);
  // confirm createServer is callable with the same injected deps shape.
  assert.ok(typeof createServer(new FakeKv(), new FakeActor(), flytlvFetch()) === "object");
});
