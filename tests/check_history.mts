// Self-check for the caller history + audit trail (step 20 + step 22). Run:
//   cd services/session-actor && npm run check  (once "check" runs both files)
//
// Fakes for ctx.storage and a Cloud Storage bucket. Verifies the actor:
//   - setLastResults appends a "search" history entry (query + resultCount +
//     topDealIds max 3) capped by SEARCH_HISTORY_MAX (oldest dropped)
//   - saveDeal appends a "save" history entry (type, dealId, conversationId)
//   - audit events go to the AuditLog singleton actor, which overwrites the
//     single object `audit/latest.json` in the bucket (never grows beyond
//     one audit key) with a MASKED caller (never the full number)
//   - a failed audit write never fails the tool call (logs ERROR, returns)
//   - AUDIT_ENABLED=false turns off audit writes (history still recorded)
//   - without an AUDIT_LOG binding, audit is skipped but history is recorded
//   - the HTTP facade's POST /actors/{digits}/getHistory returns the timeline
//     (same bearer auth as the other routes)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CallerSession,
  type Deal,
  type HistoryEntry,
} from "../services/session-actor/src/caller-session";
import { AuditLog } from "../services/session-actor/src/audit-log";
import worker from "../services/session-actor/src/index";

// Ensure audit is enabled and the slot/object limit defaults are sensible.
process.env.AUDIT_ENABLED = "true";

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

/** A real AuditLog actor instance backed by a fake ctx + a bucket. */
function auditActor(bucket: unknown) {
  return new AuditLog(fakeCtx("global") as never, { ITINERARIES: bucket } as never);
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

/** Build a CallerSession with a bucket + a real AuditLog actor (audit enabled). */
function actorWithAudit(id = "972501234") {
  const bucket = fakeBucket();
  const audit = auditActor(bucket);
  const env = { ITINERARIES: bucket, AUDIT_LOG: { idFromName: () => audit } } as never;
  const actor = new CallerSession(fakeCtx(id) as never, env);
  return { actor, bucket, audit };
}

test("setLastResults appends a search entry with query, resultCount and topDealIds", async () => {
  const { actor, bucket } = actorWithAudit();
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
  // One audit object in the bucket: audit/latest.json (NOT one per event).
  const keys = [...bucket.objects.keys()];
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "audit/latest.json");
  const auditObj = JSON.parse(bucket.objects.get("audit/latest.json")!.body);
  assert.equal(auditObj.events.length, 1);
  assert.equal(auditObj.events[0].type, "search");
  assert.equal(auditObj.events[0].conversationId, "conv-1");
});

test("topDealIds are capped to 3 even when more deals come back", async () => {
  const actor = new CallerSession(fakeCtx() as never, {} as never); // no AUDIT_LOG -> audit skipped
  await actor.setLastResults({
    deals: [deal("1"), deal("2"), deal("3"), deal("4"), deal("5")],
    query: {},
    conversationId: "conv-x",
  });
  const { history } = await actor.getHistory();
  assert.deepEqual(history[0].topDealIds, ["1", "2", "3"]);
});

test("saveDeal appends a save entry with the dealId", async () => {
  const { actor } = actorWithAudit();
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

test("audit/latest.json contains events with a masked caller, never the full id", async () => {
  const { bucket } = actorWithAudit("972501234");
  const actor = new CallerSession(
    fakeCtx("972501234") as never,
    { ITINERARIES: bucket, AUDIT_LOG: { idFromName: () => auditActor(bucket) } } as never,
  );
  await actor.setLastResults({ deals: [deal("a")], conversationId: "conv-7", query: {} });
  assert.ok(bucket.objects.has("audit/latest.json"));
  const obj = bucket.objects.get("audit/latest.json")!;
  assert.equal(obj.contentType, "application/json");
  const body = JSON.parse(obj.body);
  assert.ok(body.events.length >= 1);
  const evt = body.events[0];
  // The masked caller is *** + last 4 digits; the full id is never present.
  assert.equal(evt.caller, "***1234");
  assert.ok(!JSON.stringify(body).includes("972501234"), "full caller id never in the audit body");
  assert.equal(evt.type, "search");
  assert.equal(evt.conversationId, "conv-7");
  assert.equal(typeof evt.ts, "number");
});

test("audit/latest.json is overwritten, not grown (one object after many events)", async () => {
  const { actor, bucket } = actorWithAudit("972501234");
  for (let i = 0; i < 5; i++) {
    await actor.setLastResults({ deals: [deal(`d${i}`)], conversationId: `c${i}`, query: {} });
  }
  await actor.saveDeal({ dealId: "d4", conversationId: "c4" });
  // Still exactly one audit key in the bucket — overwritten, not grown.
  const auditKeys = [...bucket.objects.keys()].filter((k) => k.startsWith("audit/"));
  assert.equal(auditKeys.length, 1, "exactly one audit object (overwritten)");
  assert.equal(auditKeys[0], "audit/latest.json");
  const body = JSON.parse(bucket.objects.get("audit/latest.json")!.body);
  assert.equal(body.events.length, 6, "all 6 events in the single object");
});

test("a failed audit write never fails the tool call", async () => {
  const bucket = throwingBucket();
  const audit = auditActor(bucket);
  const actor = new CallerSession(
    fakeCtx("972501234") as never,
    { ITINERARIES: bucket, AUDIT_LOG: { idFromName: () => audit } } as never,
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

test("without an AUDIT_LOG binding, audit is skipped but history is still recorded", async () => {
  const actor = new CallerSession(fakeCtx() as never, {} as never);
  await actor.setLastResults({ deals: [deal("a")], conversationId: "c1", query: {} });
  const { history } = await actor.getHistory();
  assert.equal(history.length, 1);
});

test("AUDIT_ENABLED=false turns off audit writes (history is still recorded)", async () => {
  const saved = process.env.AUDIT_ENABLED;
  process.env.AUDIT_ENABLED = "false";
  try {
    const bucket = fakeBucket();
    const audit = auditActor(bucket);
    const actor = new CallerSession(
      fakeCtx("972501234") as never,
      { ITINERARIES: bucket, AUDIT_LOG: { idFromName: () => audit } } as never,
    );
    await actor.setLastResults({ deals: [deal("a")], conversationId: "c1", query: {} });
    // No audit object written (AUDIT_ENABLED=false short-circuits before the actor).
    assert.equal(
      [...bucket.objects.keys()].filter((k) => k.startsWith("audit/")).length,
      0,
      "no audit object when AUDIT_ENABLED=false",
    );
    // History is still recorded in actor storage.
    const { history } = await actor.getHistory();
    assert.equal(history.length, 1);
  } finally {
    if (saved === undefined) delete process.env.AUDIT_ENABLED;
    else process.env.AUDIT_ENABLED = saved;
  }
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
