// Self-check for search_deals filters: server-computed weekend dates and the
// country filter. Run: cd services/mcp-server && npx tsx ../../tests/check_search_filters.mts
import assert from "node:assert/strict";
import { weekendDates, inCountry } from "../services/mcp-server/src/server.ts";

const at = (iso: string) => new Date(iso + "T09:00:00Z");
assert.deepEqual(weekendDates("upcoming", at("2026-10-06")), ["2026-10-08", "2026-10-09", "2026-10-10"]); // Tue
assert.deepEqual(weekendDates("following", at("2026-10-06")), ["2026-10-15", "2026-10-16", "2026-10-17"]);
assert.deepEqual(weekendDates("upcoming", at("2026-10-09")), ["2026-10-09", "2026-10-10"]); // Fri: no past days
assert.deepEqual(weekendDates("upcoming", at("2026-10-11")), ["2026-10-15", "2026-10-16", "2026-10-17"]); // Sun

const deals = [
  { destination_airport: { country: "Greece", country_code: "GR" } },
  { destination_airport: { country: "Cyprus", country_code: "CY" } },
] as never;
assert.equal(inCountry(deals, "greece").length, 1);
assert.equal(inCountry(deals, "CY").length, 1);
assert.equal(inCountry(deals, "Italy").length, 0);
console.log("search filter checks OK");

// SMS body: details read on the call plus the booking link.
import { dealSms } from "../services/mcp-server/src/server.ts";
const text = dealSms({
  dealId: "tlv-lca-1", city: "Larnaca", country: "Cyprus", price: 64, currency: "USD",
  departureDate: "2026-11-09", returnDate: "2026-11-12", airline: "Wizz Air", direct: true,
  url: "https://flytlv.app/go?id=tlv-lca-1",
  outbound: { departs: "08:00", flightNumber: "W64604" }, inbound: { departs: "06:00", flightNumber: "W64603" },
});
assert.equal(text, "FlyTLV: Larnaca, Cyprus - 64 USD round trip, direct.\nOut 2026-11-09 08:00 W64604. Back 2026-11-12 06:00 W64603.\nBook: https://flytlv.app/go?id=tlv-lca-1");
console.log("sms text check OK");

// Departed / too-soon flights are dropped (3 h minimum, Israel time).
import { bookable } from "../services/mcp-server/src/server.ts";
const now = new Date("2026-10-06T15:00:00Z"); // 18:00 in Israel
const kept = bookable([
  { deal_id: "gone", departure_date: "2026-10-06", outbound_departure_time: "18:40" },
  { deal_id: "soon", departure_date: "2026-10-06", outbound_departure_time: "20:30" },
  { deal_id: "ok", departure_date: "2026-10-06", outbound_departure_time: "21:30" },
  { deal_id: "later", departure_date: "2026-10-07", outbound_departure_time: "06:00" },
] as never, now).map((d: { deal_id: string }) => d.deal_id);
assert.deepEqual(kept, ["ok", "later"]);
console.log("bookable check OK");

// Caller requests -> feed params and our own filters (category, nights, weekday).
import { buildParams, applyFilters } from "../services/mcp-server/src/server.ts";
const rt = buildParams({ min_discount_pct: 50, max_layover_hours: 3, time_of_day: ["morning"], sort: "best_value" }, "");
assert.equal(rt.min_discount_pct, "50");
assert.equal(rt.max_layover, "180");
assert.equal(rt.time_windows, "morning");
assert.equal(rt.sort, "best");
assert.equal(buildParams({ category: "Hanukkah" }, "").limit, "300"); // broad fetch for local filters
const ow = buildParams({ trip_type: "one_way", min_discount_pct: 50, sort: "soonest" }, "2026-11-18");
assert.equal(ow.date, "2026-11-18");
assert.equal(ow.sort, "date_asc");
assert.equal(ow.min_discount_pct, undefined); // not a one-way feed parameter
const pool = [
  { deal_id: "a", deal_category_label: "Hanukkah", nights: 3, departure_weekday: "Friday" },
  { deal_id: "b", deal_category_label: "Weekend (Thu-Sun)", nights: 3, departure_date: "2026-10-08" },
  { deal_id: "c", deal_category_label: "1 Month", nights: 28, departure_weekday: "Monday" },
] as never;
const ids = (f: object) => applyFilters(pool, f).map((d: { deal_id: string }) => d.deal_id);
assert.deepEqual(ids({ category: "hanukkah" }), ["a"]);
assert.deepEqual(ids({ category: "weekend" }), ["b"]);
assert.deepEqual(ids({ minNights: 2, maxNights: 4 }), ["a", "b"]);
assert.deepEqual(ids({ departureWeekday: "Thursday" }), ["b"]); // from the date when no weekday field
console.log("search argument checks OK");

// flytlv GET: one retry on timeout (cold connection), none on other errors.
import { FlytlvClient } from "../services/mcp-server/src/flytlv.ts";
process.env.FLYTLV_API_KEY ??= "test";
const timeout = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
let calls = 0;
const flaky = (async () => {
  if (calls++ === 0) throw timeout();
  return new Response(JSON.stringify({ currency: "USD", deals: [] }));
}) as unknown as typeof fetch;
assert.deepEqual((await new FlytlvClient(flaky).search({})).deals, []);
assert.equal(calls, 2);
calls = 0;
const down = (async () => { calls++; throw new TypeError("network"); }) as unknown as typeof fetch;
await assert.rejects(new FlytlvClient(down).search({}), /temporarily unavailable/);
assert.equal(calls, 1);
console.log("flytlv retry checks OK");
