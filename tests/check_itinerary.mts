// Self-check for the itinerary file (Cloud Storage) + the follow-up reminder
// (actor alarm). Run: cd services/session-actor && npm run check
//
// Fakes for ctx.storage (+ setAlarm/getAlarm/deleteAlarm), a Cloud Storage
// bucket, and env.TELNYX (messages.send). Verifies:
//   - saveDeal writes one HTML object and returns its URL
//   - re-save reuses it (same key, same bucket size)
//   - alarm() sends exactly one SMS; a second alarm sends none
//   - GET /itineraries/<uuid>.html returns the HTML stream
//   - GET /itineraries/<bad-id>.html is 404
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CallerSession,
  type Deal,
} from "../services/session-actor/src/caller-session";
import worker from "../services/session-actor/src/index";

// Configuration the actor reads at call time (the config helpers in
// caller-session.ts read process.env lazily; nothing is hardcoded in code).
process.env.ITINERARY_BASE_URL = "https://itinerary.test";
process.env.REMINDER_DELAY_SECONDS = "1";
process.env.SMS_FROM = "FlyTLV";
process.env.MESSAGING_PROFILE_ID = "profile-id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const deal = (id: string, city = "Larnaca", price = 64): Deal => ({
  dealId: id,
  city,
  country: "Cyprus",
  price,
  currency: "USD",
  departureDate: "2026-11-09",
  returnDate: "2026-11-12",
  airline: "Wizz Air",
  direct: true,
  url: `https://flytlv.app/go?id=${id}`,
});

/** In-memory ctx.storage plus a single alarm (setAlarm/getAlarm/deleteAlarm). */
function fakeCtx(id = "97250") {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    id,
    storage: {
      get: async (k: string) =>
        data.has(k) ? structuredClone(data.get(k)) : undefined,
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      delete: async (k: string) => data.delete(k),
      setAlarm: async (when: number) => {
        alarm = when;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  };
}

/** In-memory Cloud Storage bucket — only the put/get surface the actor and the
 * GET route actually use. `writeHttpMetadata` forwards the stored content type. */
function fakeBucket() {
  const objects = new Map<string, { body: string; contentType?: string }>();
  return {
    objects,
    async put(
      key: string,
      body: unknown,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const text = typeof body === "string" ? body : String(body ?? "");
      objects.set(key, {
        body: text,
        contentType: options?.httpMetadata?.contentType,
      });
      return null;
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        key,
        bodyUsed: false,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(obj.body));
            controller.close();
          },
        }),
        async arrayBuffer() {
          return new TextEncoder().encode(obj.body).buffer as ArrayBuffer;
        },
        async text() {
          return obj.body;
        },
        async json() {
          return JSON.parse(obj.body);
        },
        async blob() {
          return new Blob([obj.body]);
        },
        writeHttpMetadata(headers: Headers) {
          if (obj.contentType) headers.set("content-type", obj.contentType);
        },
        httpMetadata: { contentType: obj.contentType },
      };
    },
  };
}

/** Capturing Telnyx messages client (env.TELNYX.messages.send). */
function fakeTelnyx() {
  const sent: Array<{
    from: string;
    to: string;
    text: string;
    messaging_profile_id: string;
  }> = [];
  return {
    sent,
    messages: {
      async send(body: {
        from: string;
        to: string;
        text: string;
        messaging_profile_id: string;
      }) {
        sent.push(body);
        return { ok: true };
      },
    },
  };
}

function envWith(actor: unknown, bucket: unknown, telnyx: unknown) {
  return {
    CALLER_SESSION: { idFromName: () => actor },
    SECRETS: { get: async () => "tok" },
    ITINERARIES: bucket,
    TELNYX: telnyx,
  } as never;
}

test("saveDeal writes one HTML object and returns its URL", async () => {
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx() as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({ dealId: "a" });
  assert.ok(profile.itineraryUrl, "saveDeal returns itineraryUrl when configured");
  const uuid = profile.itineraryUrl!.split("/").pop()!.replace(/\.html$/, "");
  assert.match(uuid, UUID_RE, "the path segment is a strict UUID");
  assert.ok(
    profile.itineraryUrl!.startsWith("https://itinerary.test/itineraries/"),
  );
  assert.equal(bucket.objects.size, 1, "exactly one HTML object in the bucket");
  const key = [...bucket.objects.keys()][0];
  assert.equal(key, `itineraries/${uuid}.html`);
  const obj = bucket.objects.get(key)!;
  assert.equal(obj.contentType, "text/html; charset=utf-8");
  assert.match(obj.body, /<html/i);
  assert.match(obj.body, /Larnaca/);
  assert.match(obj.body, /Wizz Air/);
  // The booking link is HTML-escaped into an href attribute (no markup injection).
  assert.match(obj.body, /href="https:\/\/flytlv\.app\/go\?id=a"/);
});

test("re-save reuses the existing itinerary file (same key, no new object)", async () => {
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx() as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const first = await actor.saveDeal({ dealId: "a" });
  const second = await actor.saveDeal({ dealId: "a" });
  assert.ok(first.itineraryUrl);
  assert.ok(second.itineraryUrl);
  assert.equal(
    first.itineraryUrl,
    second.itineraryUrl,
    "re-save returns the same itinerary URL",
  );
  assert.equal(bucket.objects.size, 1, "still one HTML object after re-save");
});

test("alarm() sends exactly one SMS; a second alarm sends none", async () => {
  const bucket = fakeBucket();
  const telnyx = fakeTelnyx();
  const actor = new CallerSession(
    fakeCtx("97250") as never,
    { ITINERARIES: bucket, TELNYX: telnyx } as never,
  );
  await actor.setLastResults({ deals: [deal("a", "Palermo", 99)] });
  const profile = await actor.saveDeal({ dealId: "a" });
  assert.ok(profile.itineraryUrl);

  await actor.alarm({ retryCount: 0, isRetry: false });
  assert.equal(telnyx.sent.length, 1, "first alarm sends exactly one SMS");
  const sms = telnyx.sent[0];
  assert.equal(sms.from, "FlyTLV");
  assert.equal(sms.to, "+97250");
  assert.equal(sms.messaging_profile_id, "profile-id");
  assert.match(sms.text, /Still thinking about Palermo for 99 USD\? Your itinerary: /);
  assert.ok(
    sms.text.endsWith(profile.itineraryUrl!),
    "SMS ends with the itinerary URL",
  );

  await actor.alarm({ retryCount: 0, isRetry: false });
  assert.equal(telnyx.sent.length, 1, "second alarm sends no SMS (reminder drained)");
});

test("GET /itineraries/<uuid>.html streams the HTML with its content type", async () => {
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx() as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({ dealId: "a" });
  const uuid = profile.itineraryUrl!.split("/").pop()!.replace(/\.html$/, "");

  const resp = await worker.fetch(
    new Request(`https://x/itineraries/${uuid}.html`),
    envWith(actor, bucket, fakeTelnyx()),
  );
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await resp.text();
  assert.match(body, /<html/i);
  assert.match(body, /Larnaca/);
});

test("GET /itineraries/<bad-id>.html is 404 (regex + missing object)", async () => {
  const bucket = fakeBucket();
  const env = envWith(null, bucket, fakeTelnyx());
  // Not a UUID at all -> 404 (regex check).
  assert.equal(
    (
      await worker.fetch(
        new Request("https://x/itineraries/not-a-uuid.html"),
        env,
      )
    ).status,
    404,
  );
  // UUID shape but no such object in the bucket -> 404 (object missing).
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://x/itineraries/00000000-0000-0000-0000-000000000000.html",
        ),
        env,
      )
    ).status,
    404,
  );
});

test("saveDeal degrades safely when the bucket/alarm/url is unconfigured", async () => {
  // Mirrors the unit-test contract from AGENTS.md step 7: with {} as env and a
  // ctx without setAlarm, saveDeal still succeeds and omits itineraryUrl.
  const strippedCtx = {
    id: "97250",
    storage: {
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
    },
  } as never;
  const data = new Map<string, unknown>();
  const noTelnyx = fakeTelnyx();
  const actor = new CallerSession(
    strippedCtx,
    {} as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({ dealId: "a" });
  assert.equal(profile.savedCount, 1);
  assert.equal(profile.itineraryUrl, undefined);
  assert.equal(noTelnyx.sent.length, 0);
});
