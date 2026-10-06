// Self-check for search_deals filters: server-computed weekend dates and the
// country filter. Run: cd services/mcp-server && npx tsx ../../UnitTest/check_search_filters.mts
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
