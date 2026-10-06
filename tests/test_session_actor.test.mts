/**
 * Unit tests for the CallerSession actor and the HTTP layer (src/index.ts).
 * Run: cd services/session-actor && npm test   (node:test via tsx)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallerSession, type Deal } from "../services/session-actor/src/caller-session";
import worker from "../services/session-actor/src/index";

/** In-memory stand-in for ctx.storage. */
function fakeCtx(id = "97250") {
  const data = new Map<string, unknown>();
  return {
    id,
    storage: {
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
    },
  };
}

const deal = (id: string, city = "Larnaca"): Deal => ({
  dealId: id, city, country: "Cyprus", price: 64, currency: "USD",
  departureDate: "2026-11-09", returnDate: "2026-11-12", airline: "Wizz Air", direct: true, url: "u",
});

const newActor = () => new CallerSession(fakeCtx() as never, {} as never);

test("recordCall increments the call count", async () => {
  const actor = newActor();
  assert.equal((await actor.recordCall()).callCount, 1);
  assert.equal((await actor.recordCall()).callCount, 2);
});

test("saveDeal saves from last results, without duplicates", async () => {
  const actor = newActor();
  await actor.setLastResults({ deals: [deal("a"), deal("b", "Palermo")] });
  await actor.saveDeal({ dealId: "a" });
  await actor.saveDeal({ dealId: "a" });
  const { savedCount } = await actor.saveDeal({ dealId: "b" });
  assert.equal(savedCount, 2);
  const profile = await actor.getProfile();
  assert.equal(profile.lastSaved?.city, "Palermo");
});

test("saveDeal rejects unknown deals and bad input", async () => {
  const actor = newActor();
  await assert.rejects(actor.saveDeal({ dealId: "zzz" }), /last search results/);
  await assert.rejects(actor.saveDeal({}), /dealId/);
  await assert.rejects(actor.setLastResults({ deals: "nope" }), /array/);
});

// ---- HTTP layer ----------------------------------------------------------

function fakeEnv(actor = newActor()) {
  return {
    CALLER_SESSION: { idFromName: () => actor },
    SECRETS: { get: async () => "tok" },
  } as never;
}

const call = (path: string, token = "tok", body: unknown = {}) =>
  worker.fetch(new Request(`https://x${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}` },
  }), fakeEnv());

test("http: wrong token is 401", async () => {
  assert.equal((await call("/actors/97250/recordCall", "bad")).status, 401);
});

test("http: allowed method returns JSON", async () => {
  const resp = await call("/actors/97250/recordCall");
  assert.equal(resp.status, 200);
  assert.equal(((await resp.json()) as { callCount: number }).callCount, 1);
});

test("http: unknown method or bad id is 400, bad path is 404", async () => {
  assert.equal((await call("/actors/97250/deleteEverything")).status, 400);
  assert.equal((await call("/actors/bad%20id!/recordCall")).status, 400);
  assert.equal((await call("/nope")).status, 404);
});

test("http: actor input error is 400 with the message", async () => {
  const resp = await call("/actors/97250/saveDeal", "tok", { dealId: "missing" });
  assert.equal(resp.status, 400);
  assert.match(((await resp.json()) as { error: string }).error, /last search results/);
});
