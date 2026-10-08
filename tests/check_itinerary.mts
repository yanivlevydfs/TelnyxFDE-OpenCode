// Self-check for the itinerary file (Cloud Storage) + the follow-up reminder
// (actor alarm). Run: cd services/session-actor && npm run check
//
// Fakes for ctx.storage (+ setAlarm/getAlarm/deleteAlarm), a Cloud Storage
// bucket, and env.TELNYX (messages.send). Verifies the step-22 slot-token
// design:
//   - saveDeal writes to the caller's fixed slot (`itineraries/slot-<n>.html`)
//     and returns a URL `/itineraries/<slot>-<token>.html`
//   - re-save overwrites the same slot with a FRESH token (different URL,
//     same slot key, same bucket object count)
//   - an old token on the same slot returns 404 (token mismatch)
//   - alarm() sends exactly one SMS; a second alarm sends none
//   - GET /itineraries/<slot>-<token>.html streams the HTML (200)
//   - GET /itineraries/<bad-id>.html is 404 (regex + slot mismatch + missing
//     object + token mismatch)
//   - saveDeal degrades safely without bucket/alarm/url
//   - config travels with the call (no process.env): itineraryUrl returned,
//     alarm SMS uses the passed smsFrom / messagingProfileId
//   - bad-typed config is dropped in favour of the process.env fallback
//   - guard: ITINERARY_SLOTS + 1 <= STORAGE_MAX_OBJECTS
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CallerSession,
  slotFor,
  type Deal,
} from "../services/session-actor/src/caller-session";
import { AuditLog } from "../services/session-actor/src/audit-log";
import worker from "../services/session-actor/src/index";

// Configuration the actor reads at call time (the config helpers in
// caller-session.ts read process.env lazily; nothing is hardcoded in code).
process.env.ITINERARY_BASE_URL = "https://itinerary.test";
process.env.REMINDER_DELAY_SECONDS = "1";
process.env.SMS_FROM = "FlyTLV";
process.env.MESSAGING_PROFILE_ID = "profile-id";
process.env.ITINERARY_SLOTS = "4";
process.env.STORAGE_MAX_OBJECTS = "5";

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

/** Build an env that includes an AuditLog actor instance for audit writes. */
function envWith(actor: unknown, bucket: unknown, telnyx: unknown) {
  const auditLog = new AuditLog(fakeCtx("global") as never, { ITINERARIES: bucket } as never);
  return {
    CALLER_SESSION: { idFromName: () => actor },
    SECRETS: { get: async () => "tok" },
    ITINERARIES: bucket,
    TELNYX: telnyx,
    AUDIT_LOG: { idFromName: () => auditLog },
  } as never;
}

/** Environment without an AUDIT_LOG binding — audit is skipped (WARNING). */
function envNoAudit(actor: unknown, bucket: unknown, telnyx: unknown) {
  return {
    CALLER_SESSION: { idFromName: () => actor },
    SECRETS: { get: async () => "tok" },
    ITINERARIES: bucket,
    TELNYX: telnyx,
  } as never;
}

test("saveDeal writes one HTML object to the caller slot and returns a slot-token URL", async () => {
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx("97250") as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({ dealId: "a" });
  assert.ok(profile.itineraryUrl, "saveDeal returns itineraryUrl when configured");
  // URL is /itineraries/<slot>-<token>.html
  const filename = profile.itineraryUrl!.split("/").pop()!.replace(/\.html$/, "");
  const m = filename.match(/^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  assert.ok(m, "the path segment is <slot>-<token>");
  const slot = Number(m![1]);
  const token = m![2];
  assert.match(token, UUID_RE, "the token is a strict UUID");
  assert.equal(slot, slotFor("97250", 4), "slot = stableHash(callerId) mod SLOTS");
  assert.ok(
    profile.itineraryUrl!.startsWith("https://itinerary.test/itineraries/"),
  );
  assert.equal(
    [...bucket.objects.keys()].filter((k) => k.startsWith("itineraries/")).length,
    1,
    "exactly one itinerary HTML object in the bucket",
  );
  const key = `itineraries/slot-${slot}.html`;
  assert.ok(bucket.objects.has(key), "the object key is itineraries/slot-<n>.html");
  const obj = bucket.objects.get(key)!;
  assert.equal(obj.contentType, "text/html; charset=utf-8");
  assert.match(obj.body, /^<!-- token:[0-9a-f-]+ -->/, "HTML starts with a token comment");
  assert.ok(obj.body.includes(token), "the stored token matches the URL token");
  assert.match(obj.body, /<html/i);
  assert.match(obj.body, /Larnaca/);
  assert.match(obj.body, /Wizz Air/);
  // The booking link is HTML-escaped into an href attribute (no markup injection).
  assert.match(obj.body, /href="https:\/\/flytlv\.app\/go\?id=a"/);
});

test("re-save overwrites the same slot with a fresh token (new URL, same key, same count)", async () => {
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
  assert.notEqual(
    first.itineraryUrl,
    second.itineraryUrl,
    "re-save returns a DIFFERENT URL (fresh token)",
  );
  // Same slot in both URLs.
  const slot1 = Number(first.itineraryUrl!.split("/").pop()!.match(/^(\d+)-/)![1]);
  const slot2 = Number(second.itineraryUrl!.split("/").pop()!.match(/^(\d+)-/)![1]);
  assert.equal(slot1, slot2, "re-save maps to the same slot");
  assert.equal(
    [...bucket.objects.keys()].filter((k) => k.startsWith("itineraries/")).length,
    1,
    "still one itinerary object after re-save (overwrite, no grow)",
  );
  // The first URL's token no longer matches (the object now has the second token).
  const key = `itineraries/slot-${slot2}.html`;
  const body = bucket.objects.get(key)!.body;
  const storedToken = body.match(/^<!-- token:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) -->/)![1];
  const extractToken = (url: string) =>
    url.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.html$/)![1];
  const firstToken = extractToken(first.itineraryUrl!);
  assert.notEqual(storedToken, firstToken, "the object's token is the second write's token, not the first");
  const secondToken = extractToken(second.itineraryUrl!);
  assert.equal(storedToken, secondToken, "the object's token matches the second URL");
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

test("GET /itineraries/<slot>-<token>.html streams the HTML with its content type", async () => {
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx() as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({ dealId: "a" });
  assert.ok(profile.itineraryUrl);

  const resp = await worker.fetch(
    new Request(profile.itineraryUrl!),
    envNoAudit(actor, bucket, fakeTelnyx()),
  );
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await resp.text();
  assert.match(body, /<html/i);
  assert.match(body, /Larnaca/);
});

test("GET /itineraries/<bad-id>.html is 404 (regex + slot mismatch + missing object + token mismatch)", async () => {
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx() as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  // Write an itinerary so we can test token mismatch on a real slot.
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({ dealId: "a" });
  assert.ok(profile.itineraryUrl);
  const env = envNoAudit(actor, bucket, fakeTelnyx());

  // Not a slot-token format at all -> 404 (regex check).
  assert.equal(
    (await worker.fetch(new Request("https://x/itineraries/not-a-uuid.html"), env)).status,
    404,
  );
  // UUID shape but no slot separator -> 404.
  assert.equal(
    (await worker.fetch(
      new Request("https://x/itineraries/00000000-0000-0000-0000-000000000000.html"),
      env,
    )).status,
    404,
  );
  // Slot out of range -> 404.
  assert.equal(
    (await worker.fetch(new Request("https://x/itineraries/99-00000000-0000-0000-0000-000000000000.html"), env)).status,
    404,
  );
  // Valid slot, valid token shape, but no object in the bucket -> 404.
  assert.equal(
    (await worker.fetch(new Request("https://x/itineraries/1-00000000-0000-0000-0000-000000000000.html"), env)).status,
    404,
  );
  // Valid slot, object exists, but WRONG token -> 404 (never shows someone else's trip).
  const realSlot = Number(profile.itineraryUrl!.split("/").pop()!.match(/^(\d+)-/)![1]);
  const fakeToken = "00000000-0000-0000-0000-000000000000";
  assert.equal(
    (await worker.fetch(new Request(`https://x/itineraries/${realSlot}-${fakeToken}.html`), env)).status,
    404,
    "wrong token on a real slot returns 404",
  );
});

test("saveDeal degrades safely when the bucket/alarm/url is unconfigured", async () => {
  // Mirrors the unit-test contract from AGENTS.md step 7: with {} as env and a
  // ctx without setAlarm, saveDeal still succeeds and omits itineraryUrl.
  const ctxData = new Map<string, unknown>();
  const strippedCtx = {
    id: "97250",
    storage: {
      get: async (k: string) => ctxData.get(k),
      put: async (k: string, v: unknown) => void ctxData.set(k, structuredClone(v)),
    },
  } as never;
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

test("saveDeal with config in the call survives absent process.env (step 11 live fix)", async () => {
  // Live finding (7 Oct 08:52 UTC): the actor's umbrella telnyx.toml
  // [env_vars] do NOT reach actor instances' process.env (logged
  // `itinerary_skipped reason=noITINERARY_BASE_URL`), while the MCP
  // server's func.toml [env_vars] do. The MCP server therefore forwards
  // itinerary/reminder config on every saveDeal call as `config`. Strip
  // the env vars here, hand the values over in `config` and assert:
  //   - itineraryUrl is still returned (uses config.itineraryBaseUrl)
  //   - alarm() sends exactly one SMS using the passed smsFrom /
  //     messagingProfileId (captured into the pending reminder at save
  //     time, since the alarm turn won't see process.env either)
  //   - a second alarm sends nothing (at-least-once reminder drained)
  const names = [
    "ITINERARY_BASE_URL",
    "REMINDER_DELAY_SECONDS",
    "SMS_FROM",
    "MESSAGING_PROFILE_ID",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    const bucket = fakeBucket();
    const telnyx = fakeTelnyx();
    const actor = new CallerSession(
      fakeCtx("97250") as never,
      { ITINERARIES: bucket, TELNYX: telnyx } as never,
    );
    await actor.setLastResults({ deals: [deal("a", "Budapest", 120)] });
    const profile = await actor.saveDeal({
      dealId: "a",
      config: {
        itineraryBaseUrl: "https://cfg.example",
        reminderDelaySeconds: 2,
        smsFrom: "ConfigFrom",
        messagingProfileId: "cfg-profile",
        itinerarySlots: 4,
        storageMaxObjects: 5,
      },
    });
    assert.ok(
      profile.itineraryUrl,
      "itineraryUrl returned with config + no process.env",
    );
    assert.ok(
      profile.itineraryUrl!.startsWith("https://cfg.example/itineraries/"),
      "itineraryUrl uses the passed itineraryBaseUrl",
    );

    await actor.alarm({ retryCount: 0, isRetry: false });
    assert.equal(telnyx.sent.length, 1, "alarm sends exactly one SMS");
    const sms = telnyx.sent[0];
    assert.equal(sms.from, "ConfigFrom", "SMS uses the passed smsFrom");
    assert.equal(sms.to, "+97250");
    assert.equal(
      sms.messaging_profile_id,
      "cfg-profile",
      "SMS uses the passed messagingProfileId",
    );
    assert.match(
      sms.text,
      /Still thinking about Budapest for 120 USD\? Your itinerary: /,
    );
    assert.ok(
      sms.text.endsWith(profile.itineraryUrl!),
      "SMS ends with the itinerary URL",
    );

    // at-least-once: a second alarm after the reminder is drained sends none.
    await actor.alarm({ retryCount: 0, isRetry: false });
    assert.equal(telnyx.sent.length, 1, "second alarm sends no SMS");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("saveDeal ignores bad-typed config values and falls back to process.env", async () => {
  // Requirements of step 11: validate types (strings, a positive number) and
  // ignore bad ones — so a broken config field can never break the save or
  // shadow a good process.env fallback. With process.env.ITINERARY_BASE_URL
  // still set at the file scope, a number-typed `itineraryBaseUrl` in the
  // config must be dropped and `https://itinerary.test` must win.
  const bucket = fakeBucket();
  const actor = new CallerSession(
    fakeCtx() as never,
    { ITINERARIES: bucket, TELNYX: fakeTelnyx() } as never,
  );
  await actor.setLastResults({ deals: [deal("a")] });
  const profile = await actor.saveDeal({
    dealId: "a",
    config: {
      itineraryBaseUrl: 42 as unknown as string,
      reminderDelaySeconds: "abc" as unknown as number,
      smsFrom: 99 as unknown as string,
      messagingProfileId: { id: "x" } as unknown as string,
      itinerarySlots: "bad" as unknown as number,
      storageMaxObjects: -1 as unknown as number,
    },
  });
  assert.ok(
    profile.itineraryUrl,
    "saveDeal still resolves itineraryUrl from the process.env fallback",
  );
  assert.ok(
    profile.itineraryUrl!.startsWith("https://itinerary.test/itineraries/"),
    "itineraryUrl uses process.env.ITINERARY_BASE_URL (bad config ignored)",
  );
});

test("guard: ITINERARY_SLOTS + 1 <= STORAGE_MAX_OBJECTS (constant check)", () => {
  const slots = Number(process.env.ITINERARY_SLOTS ?? "4");
  const max = Number(process.env.STORAGE_MAX_OBJECTS ?? "5");
  assert.ok(
    slots + 1 <= max,
    `ITINERARY_SLOTS(${slots}) + 1 must be <= STORAGE_MAX_OBJECTS(${max})`,
  );
});
