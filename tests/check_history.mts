// Self-check for the caller history + audit trail (step 20). Run:
//   cd services/session-actor && npm run check  (once "check" runs both files)
//
// Fakes for ctx.storage and a Cloud Storage bucket. Verifies the actor:
//   - setLastResults appends a "search" history entry (query + resultCount +
//     topDealIds max 3) capped by SEARCH_HISTORY_MAX (oldest dropped)
//   - saveDeal appends a "save" history entry (type, dealId, conversationId)
//   - an audit JSON object is written to the bucket per event under
//     audit/<YYYY-MM-DD>/<conversationId>/<ts>-<type>.json with a MASKED caller
//     (never the full actor id)
//   - a failed audit write never fails the tool call (logs ERROR, returns)
//   - the HTTP facade's POST /actors/{digits}/getHistory returns the timeline
//     (same bearer auth as the other routes)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CallerSession,
  type Deal,
  type HistoryEntry,
} from "../services/session-actor/src/caller-session";
import worker from "../services/session-actor/src/index";

const deal = (id: string, city = "Larnaca"): Deal => ({
  dealId: id, city, country: "Cyprus", price: 64, currency: "USD",
  departureDate: "2026-11-09", returnDate: "2026-11-12", airline: "Wizz Air", direct: true, url: "u",
});

/** In-memory ctx.storage. */
function fakeCtx(id = "972501234") {
  const data = new Map<string, unknown>();
  return {
    id,
    storage: {
      get: async (k: string) => data.has(k) ? structuredClone(data.get(k)) : undefined,
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      delete: async (k: string) => data.delete(k),
    },
  };
}

/** In-memory Cloud Storage bucket (only the put/get surface the audit write uses). */
function fakeBucket() {
  const objects = new Map<string, { body: string; contentType?: string }>();
  return {
    objects,
    async put(
      key: string, body: unknown,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const text = typeof body === "string" ? body : String(body ?? "");
      objects.set(key, { body: text, contentType: options?.httpMetadata?.contentType });
      return null;
    },
    async get(key: string) {
      return objects.get(key) ?? null;
    },
  };
}

/** A bucket whose put always rejects — to prove a failed audit never breaks a call. */
function throwingBucket() {
  return {
    async put(): Promise<never> { throw new Error("cloud storage down"); },
    async get(): Promise<null> { return null; },
  };
}

/** Build an actor with a bucket (audit writes enabled). */
function actorWithBucket(id = "972501234") {
  const bucket = fakeBucket();
  const actor = new CallerSession(fakeCtx(id) as never, { ITINERARIES: bucket } as never);
  return { actor, bucket };
}

const AUDIT_KEY = /^audit\/\d{4}-\d{2}-\d{2}\/[^/]+\/\d+-(search|save)\.json$/;

test("setLastResults appends a search entry with query, resultCount and topDealIds", async () => {
  const { actor, bucket } = actorWithBucket();
  await actor.setLastResults({
    deals: [deal("a"), deal("b", "Palermo"), deal("c", "Athens")],
    query: { destination: "LCA", direct_only: true },
    conversationId: "conv-1",
  });
  const { history } = await actor.getHistory();
  assert.equal(history.length, 1);
  const entry = history[0];
  assert.equal(entry.type, "search");
  assert.equal(entry.conversationId, "conv-1");
  assert.deepEqual(entry.query, { destination: "LCA", direct_only: true });
  assert.equal(entry.resultCount, 3);
  assert.deepEqual(entry.topDealIds, ["a", "b", "c"]);
  // One audit object in the bucket under audit/<date>/conv-1/<ts>-search.json.
  const keys = [...bucket.objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], AUDIT_KEY);
  assert.ok(keys[0].includes("/conv-1/"));
  assert.ok(keys[0].endsWith("-search.json"));
});

test("topDealIds are capped to 3 even when more deals come back", async () => {
  const actor = new CallerSession(fakeCtx() as never, {} as never); // no bucket -> audit skipped
  await actor.setLastResults({
    deals: [deal("1"), deal("2"), deal("3"), deal("4"), deal("5")],
    query: {},
    conversationId: "conv-x",
  });
  const { history } = await actor.getHistory();
  assert.deepEqual(history[0].topDealIds, ["1", "2", "3"]);
});

test("saveDeal appends a save entry with the dealId", async () => {
  const { actor } = actorWithBucket();
  await actor.setLastResults({ deals: [deal("a")], conversationId: "conv-1" });
  await actor.saveDeal({ dealId: "a", conversationId: "conv-1" });
  const { history } = await actor.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].type, "search");
  assert.equal(history[1].type, "save");
  assert.equal(history[1].dealId, "a");
  assert.equal(history[1].conversationId, "conv-1");
});

test("searchHistory is capped: oldest entries dropped at SEARCH_HISTORY_MAX", async () => {
  const saved = process.env.SEARCH_HISTORY_MAX;
  process.env.SEARCH_HISTORY_MAX = "3";
  try {
    const actor = new CallerSession(fakeCtx() as never, {} as never);
    for (let i = 0; i < 5; i++) {
      await actor.setLastResults({ deals: [deal(`d${i}`)], conversationId: `c${i}` });
    }
    const { history } = await actor.getHistory();
    assert.equal(history.length, 3, "capped at SEARCH_HISTORY_MAX=3");
    // The newest 3 are kept (d2, d3, d4) — oldest dropped.
    assert.deepEqual(
      history.map((h: HistoryEntry) => h.topDealIds?.[0]),
      ["d2", "d3", "d4"],
    );
  } finally {
    if (saved === undefined) delete process.env.SEARCH_HISTORY_MAX;
    else process.env.SEARCH_HISTORY_MAX = saved;
  }
});

test("audit object is written with a masked caller, never the full id", async () => {
  const { bucket } = actorWithBucket("972501234");
  const actor = new CallerSession(
    fakeCtx("972501234") as never, { ITINERARIES: bucket } as never,
  );
  await actor.setLastResults({ deals: [deal("a")], conversationId: "conv-7", query: {} });
  const keys = [...bucket.objects.keys()];
  assert.equal(keys.length, 1);
  const obj = bucket.objects.get(keys[0])!;
  assert.equal(obj.contentType, "application/json");
  const body = JSON.parse(obj.body);
  // The masked caller is *** + last 4 digits; the full id is never present.
  assert.equal(body.caller, "***1234");
  assert.ok(!JSON.stringify(body).includes("972501234"), "full caller id never in the audit body");
  assert.equal(body.type, "search");
  assert.equal(body.conversationId, "conv-7");
  assert.equal(typeof body.ts, "number");
});

test("a failed audit write never fails the tool call", async () => {
  const actor = new CallerSession(
    fakeCtx("972501234") as never,
    { ITINERARIES: throwingBucket() as never } as never,
  );
  // setLastResults and saveDeal must both complete despite the bucket throwing.
  const out = await actor.setLastResults({ deals: [deal("a")], conversationId: "c1", query: {} });
  assert.equal(out.stored, 1);
  const profile = await actor.saveDeal({ dealId: "a", conversationId: "c1" });
  assert.equal(profile.savedCount, 1);
  // The history was still recorded in actor storage.
  const { history } = await actor.getHistory();
  assert.equal(history.length, 2);
});

test("without a bucket, audit is skipped but history is still recorded", async () => {
  const actor = new CallerSession(fakeCtx() as never, {} as never);
  await actor.setLastResults({ deals: [deal("a")], conversationId: "c1", query: {} });
  const { history } = await actor.getHistory();
  assert.equal(history.length, 1);
});

test("HTTP getHistory route returns the timeline (bearer auth)", async () => {
  const actor = new CallerSession(fakeCtx("972501234") as never, {} as never);
  await actor.setLastResults({ deals: [deal("a")], conversationId: "c1", query: { destination: "LCA" } });
  await actor.saveDeal({ dealId: "a", conversationId: "c1" });

  const env = {
    CALLER_SESSION: { idFromName: () => actor } as never,
    SECRETS: { get: async () => "tok" } as never,
  };
  const ok = await worker.fetch(new Request("https://x/actors/972501234/getHistory", {
    method: "POST", body: JSON.stringify({}), headers: { authorization: "Bearer tok" },
  }), env);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { history: HistoryEntry[] };
  assert.equal(body.history.length, 2);
  assert.equal(body.history[0].type, "search");
  assert.equal(body.history[1].type, "save");

  // Wrong token is 401 (same auth as the other routes).
  const bad = await worker.fetch(new Request("https://x/actors/972501234/getHistory", {
    method: "POST", body: JSON.stringify({}), headers: { authorization: "Bearer nope" },
  }), env);
  assert.equal(bad.status, 401);
});
