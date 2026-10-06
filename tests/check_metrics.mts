// Self-check for the MetricsCounter actor (counters + latency) and the facade's
// /metrics routes. Run: cd services/session-actor && npx tsx ../../tests/check_metrics.mts
import assert from "node:assert/strict";
import { MetricsCounter } from "../services/session-actor/src/metrics-counter.ts";
import worker from "../services/session-actor/src/index.ts";

function fakeCtx() {
  const data = new Map<string, unknown>();
  return {
    id: "global",
    storage: {
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
    },
  };
}

const m = new MetricsCounter(fakeCtx() as never, {} as never);
await m.add({ counts: { "webhook.calls": 1, "callers.returning": 1 }, latency: { "webhook.request": 100 } });
await m.add({ counts: { "webhook.calls": 1 }, latency: { "webhook.request": 300 } });
const snap = await m.snapshot();
assert.deepEqual(snap.counts, { "webhook.calls": 2, "callers.returning": 1 });
assert.deepEqual(snap.latency["webhook.request"], { count: 2, avg_ms: 200, max_ms: 300 });
assert.ok(snap.since);
await assert.rejects(m.add({ counts: { "Bad Name!": 1 } }), /must be a non-negative number/);
await assert.rejects(m.add({ counts: { "x.y": -1 } }), /must be a non-negative number/);
await m.reset();
assert.deepEqual((await m.snapshot()).counts, {});

// Facade: /metrics/* needs the bearer token and routes to the "global" instance.
const env = {
  INTERNAL_API_TOKEN: "t",
  CALLER_SESSION: {} as never,
  METRICS: { idFromName: (name: string) => (assert.equal(name, "global"), m) } as never,
};
const post = (path: string, body: unknown, auth = "Bearer t") =>
  worker.fetch(new Request(`https://x${path}`, {
    method: "POST", headers: { authorization: auth }, body: JSON.stringify(body),
  }), env as never);
assert.equal((await post("/metrics/add", { counts: { "a.b": 1 } }, "Bearer nope")).status, 401);
assert.equal((await post("/metrics/add", { counts: { "a.b": 2 } })).status, 200);
assert.deepEqual(((await (await post("/metrics/snapshot", {})).json()) as { counts: object }).counts, { "a.b": 2 });
assert.equal((await post("/metrics/nope", {})).status, 404);
console.log("metrics checks OK");
process.exit(0);
