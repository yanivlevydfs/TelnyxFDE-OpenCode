/**
 * src/server.ts — MCP tools + the per-request HTTP handler for fde-mcp.
 *
 * Tools (registered on an `mcp` SDK `McpServer`) that the Telnyx AI
 * Assistant calls mid-conversation over stateless Streamable HTTP:
 *
 *   - `search_deals`     — query the flytlv.app deals API (KV-cached) by
 *                         destination, country, weekend or date, and remember
 *                         the deals on the caller's Stateful Actor
 *                         (`setLastResults`) so a later save or SMS can only use
 *                         a deal the caller was actually offered.
 *   - `save_deal`        — save one of the last-shown deals to the caller's actor.
 *   - `list_saved_deals` — read the deals the caller saved on previous calls.
 *   - `send_deal_sms`    — text the caller a shown deal and its booking link
 *                         (registered only when an SMS sender is wired).
 *
 * Every value comes from an environment variable / Edge secret — nothing is
 * hardcoded. Bearer auth (`MCP_API_KEY`) is checked in `createHandler` BEFORE
 * the MCP transport sees the request. Expected tool failures return
 * `{ content:[{type:"text",text:msg}], isError:true }` so the LLM receives
 * `isError: true` and can recover gracefully.
 *
 * Edge has no request lifespan, so a stateless `StreamableHTTPServerTransport`
 * (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) is created per
 * request. Telnyx sends the conversation id in `params._meta.telnyx_conversation_id`;
 * each tool resolves the caller from `session/<conversation_id>` in KV and
 * forwards the same `trace_id` to the actor.
 *
 * Dependencies (`kv`, `actor`, `fetchImpl`, `sms`, `metrics`) are injected so tests pass fakes;
 * `index.ts` wires the real Telnyx clients in production.
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { config } from "./config.js";
import { debug, error, info, setTraceId, warning, traceContext } from "./log.js";
import {
  Actor,
  ActorError,
  ActorInputError,
} from "./actor.js";
import { FlytlvClient, FlytlvError, type FlytlvPayload } from "./flytlv.js";
import type { SmsSender } from "./sms.js";
import type { Metrics } from "./actor.js";

// ------------------------------------------------------------------ public API

/** Dependencies injected into `createServer` / `createHandler`. */
export interface Dependencies {
  /** JSON KV wrapper (real `EdgeKv` or a fake). */
  kv: Kv;
  /** Actor facade client (real `ActorClient` or a fake). */
  actor: Actor;
  /** HTTP transport for upstream calls (flytlv; the real `ActorClient` shares it). */
  fetchImpl: typeof fetch;
  /** Optional SMS sender; when present a 4th tool, `send_deal_sms`, is registered. */
  sms?: SmsSender;
  /** Optional metrics sink (the shared MetricsCounter actor). */
  metrics?: Metrics;
}

/** JSON KV wrapper interface (the real `EdgeKv` + fakes both implement it). */
export interface Kv {
  /** Return the JSON value at `key`, or undefined when missing. */
  getJson(key: string): Promise<unknown>;
  /** Store a JSON value at `key`, optionally with a TTL in seconds. */
  putJson(key: string, value: unknown, ttlSecs?: number): Promise<void>;
}

/** Any KV access failure (bad JSON, binding error, network error). */
export class KvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KvError";
  }
}

/** A voice-relevant deal. Mirrors the Python `slim()` output (camelCase)
 * so the actor (`Deal` in caller-session.ts) is independent of the
 * flytlv.app snake_case contract. */
export interface Deal {
  dealId: string | undefined;
  city: string | undefined;
  country: string | undefined;
  price: number | undefined;
  currency: string;
  departureDate: string | undefined;
  returnDate: string | undefined;
  airline: string | undefined;
  /** Direct flight (no connections). */
  direct: boolean;
  url: string | undefined;
  /** Flight details read aloud; present only when flytlv sends them. */
  tripType?: string; // "round_trip" | "one_way"
  category?: string; // flytlv trip category, e.g. "Hanukkah", "Weekend (Thu-Sun)"
  departureWeekday?: string;
  returnWeekday?: string;
  discountPct?: number; // percent below the route's typical price
  savingsAmount?: number; // typical price minus this price, in `currency`
  typicalPrice?: number;
  dealQuality?: string; // "exceptional" | "great" | "good"
  fromAirport?: string;
  toAirport?: string;
  nights?: number;
  outbound?: Leg;
  inbound?: Leg;
}

/** One direction of the round trip, as spoken to the caller. */
export interface Leg {
  departs?: string;
  arrives?: string;
  airline?: string;
  flightNumber?: string;
  stops?: number;
  durationMin?: number;
  /** Connections: airports (IATA) the leg stops in, and the longest layover. */
  via?: string[];
  layoverMin?: number;
  route?: string;
}

/** A raw flytlv deal (feed may omit many fields). */
interface RawDeal {
  deal_id?: string;
  price?: number;
  departure_date?: string;
  return_date?: string;
  airline?: string;
  is_direct?: boolean;
  deal_url?: string;
  nights?: number;
  origin?: { iata?: string; airport_name?: string };
  destination_airport?: { city?: string; country?: string; country_code?: string; iata?: string; airport_name?: string };
  [key: string]: unknown; // outbound_* / inbound_* leg fields
}

/** "Ben Gurion International Airport (TLV)", or whichever part is present. */
function airport(a?: { iata?: string; airport_name?: string }): string | undefined {
  if (!a?.airport_name) return a?.iata;
  return a.iata ? `${a.airport_name} (${a.iata})` : a.airport_name;
}

/** Copy only the keys whose value is present, so absent data is not spoken. */
function present<T extends object>(obj: T): Partial<T> | undefined {
  const out = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return Object.keys(out).length ? (out as Partial<T>) : undefined;
}

/** One leg from flytlv's `outbound_*` or `inbound_*` fields. */
function leg(deal: RawDeal, dir: "outbound" | "inbound"): Leg | undefined {
  const f = (k: string) => deal[`${dir}_${k}`];
  return present({
    departs: f("departure_time") as string | undefined,
    arrives: f("arrival_time") as string | undefined,
    airline: f("airline") as string | undefined,
    flightNumber: f("flight_number") as string | undefined,
    stops: f("stops") as number | undefined,
    durationMin: f("duration") as number | undefined,
    via: Array.isArray(f("via")) && (f("via") as string[]).length ? (f("via") as string[]) : undefined,
    layoverMin: (f("layover_minutes") as number | undefined) || undefined, // 0 = no layover
    route: f("route") as string | undefined,
  });
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekday name of a YYYY-MM-DD date (the feed's own field when present). */
function weekdayOf(date?: string): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

/** Reduce a raw flytlv deal to the camelCase fields read aloud / shown.
 * Only the voice-relevant fields survive; the raw payload is cached
 * wholesale so a cache hit can re-slim without another upstream call.
 * Missing fields default to `undefined` (flytlv omits e.g. `is_direct` /
 * `return_date` on some deals) rather than raising. */
export function slim(deal: RawDeal, currency: string): Deal {
  const dest = deal.destination_airport ?? {};
  return {
    dealId: deal.deal_id,
    city: dest.city,
    country: dest.country,
    price: deal.price,
    currency,
    departureDate: deal.departure_date,
    returnDate: deal.return_date,
    airline: deal.airline,
    direct: Boolean(deal.is_direct),
    url: deal.deal_url,
    // Spoken flight details: airports, times, flight numbers. Added only when
    // present, so deals without them keep the original shape.
    ...present({
      tripType: deal.trip_type as string | undefined,
      category: deal.deal_category_label as string | undefined,
      // One-way flights have no weekday field; round trips use the feed's own.
      departureWeekday: (deal.departure_weekday as string | undefined)
        ?? (deal.trip_type === "one_way" ? weekdayOf(deal.departure_date) : undefined),
      returnWeekday: deal.return_weekday as string | undefined,
      discountPct: deal.discount_pct as number | undefined,
      savingsAmount: deal.savings_amount as number | undefined,
      typicalPrice: deal.typical_price as number | undefined,
      dealQuality: deal.deal_quality as string | undefined,
      fromAirport: airport(deal.origin),
      toAirport: airport(deal.destination_airport),
      nights: deal.nights,
      // A one-way flight (/api/private/flights) carries its times at the top level.
      outbound: deal.trip_type === "one_way"
        ? present({
          departs: deal.departure_time as string | undefined,
          arrives: deal.arrival_time as string | undefined,
          airline: deal.airline,
          stops: deal.stops as number | undefined,
          durationMin: deal.duration_minutes as number | undefined,
        })
        : leg(deal, "outbound"),
      inbound: leg(deal, "inbound"),
    }),
  };
}

/** The SMS body for one deal: the details read on the call plus the booking link. */
export function dealSms(d: Deal): string {
  const o = d.outbound ?? {};
  const i = d.inbound ?? {};
  const leg = (date?: string, l: Leg = {}) =>
    [date, l.departs, l.flightNumber].filter(Boolean).join(" ");
  return [
    `FlyTLV: ${d.city}, ${d.country} - ${d.price} ${d.currency} ${d.tripType === "one_way" ? "one way" : "round trip"}${d.direct ? ", direct" : ""}.` +
      (d.savingsAmount ? ` Save ${d.savingsAmount} ${d.currency} (${d.discountPct}% off).` : ""),
    `Out ${leg(d.departureDate, o)}. Back ${leg(d.returnDate, i)}.`,
    `Book: ${d.url}`,
  ].join("\n");
}

// --------------------------------------------------------------- tool helpers

/** A caller-facing MCP tool failure (mirrors `mcp.ToolError`). Caught by the
 * tool callback and returned as `{ content, isError: true }`. */
class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Build a successful text tool result (a JSON string payload). */
function toolOk(obj: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

/** Build a caller-facing error tool result. */
function toolErrorResult(
  message: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Pull the Telnyx conversation id from request meta (per AGENTS.md). */
function conversationId(extra: unknown): string {
  if (extra && typeof extra === "object") {
    const meta = (extra as { _meta?: { telnyx_conversation_id?: unknown } })._meta;
    const id = meta?.telnyx_conversation_id;
    if (typeof id === "string") return id;
  }
  return "";
}

/** YYYY-MM-DD and weekday (0=Sun) of `d` in the caller's timezone. */
function localDay(d: Date, tz: string): { iso: string; dow: number } {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return { iso, dow };
}

/** Thursday, Friday and Saturday departure dates for a weekend, computed on
 * the server so the model never guesses dates. "upcoming" = the coming
 * weekend (today counts if it is Thu-Sat); "following" = the one after. */
export function weekendDates(which: "upcoming" | "following", now = new Date()): string[] {
  const tz = config.optional("CALLER_TIMEZONE", "Asia/Jerusalem");
  const { iso, dow } = localDay(now, tz);
  const today = new Date(`${iso}T12:00:00Z`);
  // This week's Thursday: ahead on Sun-Wed, behind on Fri/Sat (past days are dropped).
  const offset = 4 - dow + (which === "following" ? 7 : 0);
  const days: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(today.getTime() + (offset + i) * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    if (day >= iso) days.push(day); // never search in the past
  }
  return days;
}

/** Drop deals that leave too soon to book: departure (Israel local time) must
 * be at least MIN_HOURS_BEFORE_DEPARTURE hours from now. flytlv still lists
 * same-day flights after they leave. */
export function bookable(deals: RawDeal[], now = new Date()): RawDeal[] {
  const tz = config.optional("CALLER_TIMEZONE", "Asia/Jerusalem");
  const hours = config.integer("MIN_HOURS_BEFORE_DEPARTURE", 3);
  const cutoff = new Date(now.getTime() + hours * 3_600_000);
  // "YYYY-MM-DD HH:MM" in the caller's timezone, comparable as a string.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(cutoff);
  const v = (t: string) => parts.find((x) => x.type === t)?.value;
  const min = `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}`;
  return deals.filter((d) => {
    if (!d.departure_date) return true;
    const t = d.outbound_departure_time ?? d.departure_time; // round trip | one way
    const time = typeof t === "string" ? t : "23:59";
    return `${d.departure_date} ${time}` >= min;
  });
}

/** Keep deals whose destination is in `country` (English name or ISO code). */
export function inCountry(deals: RawDeal[], country: string): RawDeal[] {
  const want = country.trim().toLowerCase();
  return deals.filter((d) => {
    const a = d.destination_airport ?? {};
    return [a.country, a.country_code, d.destination_country, d.destination_country_code]
      .some((v) => typeof v === "string" && v.toLowerCase() === want);
  });
}

/** Keep deals whose flytlv trip category matches (e.g. "hanukkah", "weekend",
 * "weekdays", "1 month"), in English or Hebrew, case-insensitive. */
export function inCategory(deals: RawDeal[], category: string): RawDeal[] {
  const want = category.trim().toLowerCase();
  return deals.filter((d) => [d.deal_category_label, d.deal_category_label_he, d.package_type]
    .some((v) => typeof v === "string" && v.toLowerCase().includes(want)));
}

/** The caller-facing filters applied after the feed query. */
export interface DealFilters {
  country?: string;
  category?: string;
  minNights?: number;
  maxNights?: number;
  departureWeekday?: string;
}

/** Apply the filters the feed has no parameter for (or that we match more loosely). */
export function applyFilters(deals: RawDeal[], f: DealFilters): RawDeal[] {
  let out = deals;
  if (f.country) out = inCountry(out, f.country);
  if (f.category) out = inCategory(out, f.category);
  if (f.minNights) out = out.filter((d) => typeof d.nights === "number" && d.nights >= f.minNights!);
  if (f.maxNights) out = out.filter((d) => typeof d.nights === "number" && d.nights <= f.maxNights!);
  if (f.departureWeekday) {
    const want = f.departureWeekday.toLowerCase();
    out = out.filter((d) => ((d.departure_weekday as string | undefined) ?? weekdayOf(d.departure_date) ?? "")
      .toLowerCase() === want);
  }
  return out;
}

/** Caller id for logs: last 4 digits only (matches the webhook's mask). */
function mask(entityId: string): string {
  return entityId ? `***${entityId.slice(-4)}` : "";
}

/** search_deals arguments (validated by the tool's zod schema). */
export interface SearchArgs {
  trip_type?: "round_trip" | "one_way";
  destination?: string;
  country?: string;
  category?: string;
  weekend?: "upcoming" | "following";
  departure_date?: string;
  departure_weekday?: string;
  min_nights?: number;
  max_nights?: number;
  max_price?: number;
  min_discount_pct?: number;
  direct_only?: boolean;
  max_layover_hours?: number;
  time_of_day?: string[];
  sort?: "cheapest" | "best_value" | "biggest_discount" | "soonest" | "fastest";
}

/** Feed sort for a caller-facing sort ("biggest_discount" is re-sorted here). */
const FEED_SORT: Record<string, string> = {
  cheapest: "cheapest", best_value: "best", biggest_discount: "cheapest", soonest: "date_asc", fastest: "fastest",
};

/** Canonical, string-only flytlv query params for a search. Filters the feed
 * cannot apply (country, category, nights, weekday) run on our side, so those
 * searches fetch every destination's best deal (DEALS_BROAD_FETCH_LIMIT). */
export function buildParams(a: SearchArgs, dates: string): Record<string, string> {
  const broad = Boolean(a.country || a.category || a.min_nights || a.max_nights || a.departure_weekday
    || a.sort === "biggest_discount");
  const oneWay = a.trip_type === "one_way";
  const limit = broad
    ? config.integer("DEALS_BROAD_FETCH_LIMIT", config.integer("DEALS_COUNTRY_FETCH_LIMIT", 300))
    : config.integer("DEALS_FETCH_LIMIT", 20);
  const params: Record<string, string> = {
    // The one-way feed sorts only by cheapest or date and caps limit at 100.
    sort: oneWay ? (a.sort === "soonest" ? "date_asc" : "cheapest") : FEED_SORT[a.sort ?? "cheapest"],
    one_per_destination: "true", // at most one deal per city
    limit: String(oneWay ? Math.min(limit, 100) : limit),
  };
  if (a.destination?.trim()) params.destination = a.destination.trim().toUpperCase();
  if (a.direct_only) params.stops = "0";
  if (a.max_price) params.max_price = String(a.max_price);
  if (dates.trim()) params[oneWay ? "date" : "departure_date"] = dates.trim();
  if (!oneWay) {
    if (a.min_discount_pct) params.min_discount_pct = String(a.min_discount_pct);
    if (a.max_layover_hours) params.max_layover = String(Math.round(a.max_layover_hours * 60));
    if (a.time_of_day?.length) params.time_windows = a.time_of_day.join(",");
  }
  return params;
}

/** Deterministic KV cache key for a deals query (prefix from env). */
function cacheKey(params: Record<string, string>): string {
  const prefix = config.optional("DEALS_CACHE_PREFIX", "cache/deals/");
  // KV keys allow only a-z A-Z 0-9 - _ / = . (a "|" or "," is a 400), so join
  // with "/" and replace anything else (e.g. the commas in a date list) by "_".
  const sig = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("/")
    .replace(/[^A-Za-z0-9\-_/=.]/g, "_");
  return prefix + sig;
}

/** The caller entity for a conversation, from `session/<conversation_id>`
 * (written by the webhook). `undefined` = no session: an anonymous or hidden
 * caller id, so nothing can be saved for them. KV failure raises ToolError. */
async function readCaller(kv: Kv, conv: string): Promise<string | undefined> {
  if (!conv) return undefined;
  const prefix = config.optional("SESSION_KEY_PREFIX", "session/");
  let session: unknown;
  try {
    // One retry: Telnyx KV occasionally answers a transient 503.
    session = await kv.getJson(`${prefix}${conv}`).catch(() => kv.getJson(`${prefix}${conv}`));
  } catch (e) {
    error("mcp.session_read_failed", { conversation: conv, error: e instanceof Error ? e.message : String(e) }, e);
    throw new ToolError("The session service is unavailable; please try again later.");
  }
  const id = session && typeof session === "object" && !Array.isArray(session)
    ? (session as { entity_id?: unknown }).entity_id
    : undefined;
  return id ? String(id) : undefined;
}

/** Like readCaller, for tools that need a known caller (save / list / SMS). */
async function requireCaller(kv: Kv, conv: string): Promise<string> {
  const entityId = await readCaller(kv, conv);
  if (!entityId) throw new ToolError("I can't identify this call; please hang up and try again.");
  return entityId;
}

/** Call the caller's actor, mapping failures to caller-safe ToolErrors: the
 * actor's own input reason (e.g. "deal not in the last search results") is
 * passed on; an unreachable actor is "unavailable" (and logged). */
async function callActor(actor: Actor, entityId: string, method: string, body?: unknown): Promise<unknown> {
  try {
    return await actor.call(entityId, method, body);
  } catch (e) {
    if (e instanceof ActorInputError) throw new ToolError(e.message);
    if (e instanceof ActorError) {
      error("mcp.actor_failed", { caller: mask(entityId), method }, e);
      throw new ToolError("The session service is unavailable; please try again.");
    }
    throw e;
  }
}

/**
 * Build the per-save call config forwarded to the actor's `saveDeal`.
 *
 * Live finding (step 11, 7 Oct 08:52 UTC): the actor's umbrella `telnyx.toml`
 * `[env_vars]` do NOT reach actor instances' `process.env`
 * (`itinerary_skipped reason=noITINERARY_BASE_URL`), while this function's
 * `func.toml` `[env_vars]` do. The four values below are therefore read here
 * from this function's env and shipped on every `saveDeal` call as `config`;
 * the actor resolves `config.X ?? process.env.X` so its own env still wins for
 * unit tests / local dev / once the platform honours the actor umbrella.
 *
 * Read with `config.optional(...)` (which trims), and **omit empty values** so
 * the actor falls back to its `process.env` cleanly when nothing is set here.
 * `reminderDelaySeconds` is forwarded as a number — the actor validates a
 * positive number and treats a string as bad (so we never send a string here).
 */
function saveDealConfig(): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  const itineraryBaseUrl = config.optional("ITINERARY_BASE_URL", "");
  if (itineraryBaseUrl) cfg.itineraryBaseUrl = itineraryBaseUrl;
  const reminderRaw = config.optional("REMINDER_DELAY_SECONDS", "");
  if (reminderRaw) {
    const reminderDelaySeconds = Number.parseInt(reminderRaw, 10);
    if (Number.isFinite(reminderDelaySeconds) && reminderDelaySeconds > 0) {
      cfg.reminderDelaySeconds = reminderDelaySeconds;
    }
  }
  const smsFrom = config.optional("SMS_FROM", "");
  if (smsFrom) cfg.smsFrom = smsFrom;
  const messagingProfileId = config.optional("MESSAGING_PROFILE_ID", "");
  if (messagingProfileId) cfg.messagingProfileId = messagingProfileId;
  return cfg;
}

/**
 * Body for a `saveDeal` actor call: the chosen `dealId` plus the per-call
 * `config` (itinerary base URL, reminder delay, SMS sender / profile) the
 * actor cannot reliably read from its own `process.env` in production.
 * `config` is omitted entirely when no values are present (so unit-test
 * fakes that swallow the body keep working without a config field).
 */
function saveDealBody(dealId: string): { dealId: string; config?: Record<string, unknown> } {
  const cfg = saveDealConfig();
  return Object.keys(cfg).length ? { dealId, config: cfg } : { dealId };
}

/** The KV flag flags/assistant.sms_enabled (default on; KV failure = on). */
async function smsEnabled(kv: Kv): Promise<boolean> {
  try {
    const flags = (await kv.getJson(config.optional("KV_FLAGS_KEY", "flags/assistant"))) as
      { sms_enabled?: unknown } | undefined;
    return flags?.sms_enabled !== false;
  } catch {
    return true;
  }
}

/** Per-request metrics, flushed to the MetricsCounter actor once at the end. */
export class RequestMetrics {
  readonly counts: Record<string, number> = {};
  readonly latency: Record<string, number> = {};
  bump(name: string, n = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + n;
  }
}

const TOOL_NAMES = new Set(["search_deals", "save_deal", "list_saved_deals", "send_deal_sms"]);
const IATA = /^[A-Za-z]{3}$/;
const DATE_LIST = /^\d{4}-\d{2}-\d{2}(,\d{4}-\d{2}-\d{2}){0,13}$/;

// ------------------------------------------------------------------- server

/** Build the `McpServer`: three tools, plus `send_deal_sms` when an SMS
 * sender is wired (production). `m` collects this request's metrics. */
export function createServer(
  kv: Kv,
  actor: Actor,
  fetchImpl: typeof fetch,
  sms?: SmsSender,
  m: RequestMetrics = new RequestMetrics(),
): McpServer {
  /** A caller-facing tool error, counted. */
  const fail = (message: string) => {
    m.bump("tool.errors");
    return toolErrorResult(message);
  };
  /** Run a tool body; ToolError -> caller-safe message, anything else -> generic. */
  const guard = async (tool: string, body: () => Promise<ReturnType<typeof toolOk>>) => {
    try {
      return await body();
    } catch (e) {
      if (e instanceof ToolError) return fail(e.message);
      error(`mcp.${tool}_failed`, undefined, e);
      return fail("Something went wrong; please try again.");
    }
  };
  const server = new McpServer({
    name: config.optional("MCP_SERVER_NAME", "fde-mcp"),
    version: "0.1.0",
  });
  const flytlv = new FlytlvClient(fetchImpl);

  server.registerTool(
    "search_deals",
    {
      description:
        "Search flytlv.app for cheap flight deals from Tel Aviv (round trip by default, or one way). " +
        "Each deal has airports, dates and weekdays, times, flight numbers, layovers, nights, price, " +
        "discount vs the usual price, savings and deal quality. The deals are remembered for the " +
        "caller so save_deal and send_deal_sms can only use a deal the caller was actually offered.",
      inputSchema: {
        trip_type: z.enum(["round_trip", "one_way"]).optional().describe("Round trip (default) or one way."),
        destination: z.string().regex(IATA).optional().describe("Destination IATA airport code, e.g. LCA."),
        country: z.string().min(2).max(60).optional()
          .describe("Destination country, English name or ISO code (e.g. 'Greece' or 'GR'). Use instead of destination for a whole country."),
        category: z.string().min(2).max(40).optional()
          .describe("flytlv trip category: a holiday (Hanukkah, Purim, Passover, Shavuot, Sukkot, Rosh Hashanah, Sigd...) or a trip style ('Weekend' = weekend trips, 'Weekdays' = Sun-Thu style trips, 'Quick Visit' = 2 nights, 'Weekly', '2 Weeks', '1 Month', 'Midweek Saver', 'Deep Saver'). Round trips only."),
        weekend: z.enum(["upcoming", "following"]).optional()
          .describe("Leave on the coming weekend (Thu/Fri/Sat): 'upcoming' = this/next weekend, 'following' = the weekend after. Dates are computed by the server."),
        departure_date: z.string().regex(DATE_LIST).optional()
          .describe("Departure date YYYY-MM-DD, or a comma-separated list of dates."),
        departure_weekday: z.enum(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]).optional()
          .describe("Only departures on this weekday."),
        min_nights: z.number().int().min(1).max(60).optional().describe("Minimum nights away (round trips)."),
        max_nights: z.number().int().min(1).max(60).optional().describe("Maximum nights away (round trips)."),
        max_price: z.number().positive().optional().describe("Maximum price in the feed's currency."),
        min_discount_pct: z.number().int().min(1).max(99).optional()
          .describe("Only deals at least this many percent below the route's usual price (round trips)."),
        direct_only: z.boolean().optional().describe("Limit to direct flights only."),
        max_layover_hours: z.number().positive().max(48).optional()
          .describe("Longest acceptable layover in hours, for connecting flights (round trips)."),
        time_of_day: z.array(z.enum(["morning", "afternoon", "evening", "night"])).min(1).max(4).optional()
          .describe("Outbound departure time windows (round trips)."),
        sort: z.enum(["cheapest", "best_value", "biggest_discount", "soonest", "fastest"]).optional()
          .describe("Order of results; default cheapest."),
      },
    },
    (args, extra) => guard("search_deals", async () => {
      const conv = conversationId(extra);
      setTraceId(conv || undefined); // trace follows the conversation
      // No conversation id (e.g. the chat channel) behaves like a hidden caller id:
      // the deals are read, nothing is remembered.
      const entityId = await readCaller(kv, conv);

      const dates = args.weekend ? weekendDates(args.weekend).join(",") : (args.departure_date ?? "");
      const oneWay = args.trip_type === "one_way";
      const params = buildParams(args, dates);
      const key = cacheKey(oneWay ? { ...params, trip: "one_way" } : params); // trip only keys the cache

      // Cache lookup — failure is non-fatal: fall through to flytlv.
      let payload: FlytlvPayload | undefined;
      try {
        payload = (await kv.getJson(key)) as FlytlvPayload | undefined;
      } catch (e) {
        warning("mcp.cache_read_failed", { key, error: e instanceof Error ? e.message : String(e) });
      }
      if (payload) {
        debug("mcp.cache_hit", { key });
        m.bump("cache.hit");
      } else {
        m.bump("cache.miss");
        const t0 = Date.now();
        try {
          payload = oneWay ? await flytlv.searchOneWay(params) : await flytlv.search(params);
        } catch (e) {
          m.bump("flytlv.errors");
          if (e instanceof FlytlvError) throw new ToolError(e.message);
          throw e;
        }
        m.bump("flytlv.calls");
        m.latency["flytlv.search"] = Date.now() - t0;
        try {
          await kv.putJson(key, payload, config.integer("DEALS_CACHE_TTL", 300)); // best-effort
        } catch (e) {
          warning("mcp.cache_write_failed", { key, error: e instanceof Error ? e.message : String(e) });
        }
      }

      const currency = payload.currency ?? "";
      let deals = applyFilters((payload.deals ?? []) as RawDeal[], {
        country: args.country,
        category: oneWay ? undefined : args.category,
        minNights: oneWay ? undefined : args.min_nights,
        maxNights: oneWay ? undefined : args.max_nights,
        departureWeekday: args.departure_weekday,
      });
      if (args.sort === "biggest_discount") {
        deals = [...deals].sort((x, y) => Number(y.discount_pct ?? 0) - Number(x.discount_pct ?? 0));
      }
      deals = bookable(deals)
        // A feed row without a deal id can't be saved; the actor would reject the whole list.
        .filter((d) => typeof d.deal_id === "string" && d.deal_id.length > 0);
      const slimmed = deals.slice(0, config.integer("DEALS_RESULT_LIMIT", 5)).map((d) => slim(d, currency));

      // Remember the deals on the caller's actor (decision #13). A hidden or
      // anonymous caller id has no session: still read the deals, but nothing
      // can be saved or texted for them.
      if (entityId) await callActor(actor, entityId, "setLastResults", { deals: slimmed });
      info("mcp.search_deals", {
        caller: mask(entityId ?? ""),
        deals: slimmed.length,
        destination: params.destination ?? "",
        country: args.country ?? "",
        category: args.category ?? "",
        trip: args.trip_type ?? "round_trip",
        direct: args.direct_only ?? false,
      });
      return toolOk(entityId
        ? { deals: slimmed }
        : { deals: slimmed, note: "The caller id is hidden, so deals can be read but not saved or texted." });
    }),
  );

  server.registerTool(
    "save_deal",
    {
      description: "Save one of the deals from the last search results to the caller's profile.",
      inputSchema: {
        deal_id: z.string().min(1).max(100).describe("The dealId of a deal from the last search_deals result."),
      },
    },
    (args, extra) => guard("save_deal", async () => {
      const conv = conversationId(extra);
      setTraceId(conv || undefined);
      const entityId = await requireCaller(kv, conv);
      const dealId = args.deal_id.trim();
      // Forward the itinerary/reminder config on the saveDeal body (live
      // finding, step 11): the actor's umbrella telnyx.toml [env_vars] do not
      // reach actor instances' process.env, so we hand them over here.
      const profile = (await callActor(actor, entityId, "saveDeal", saveDealBody(dealId))) as
        | { itineraryUrl?: string }
        | undefined;
      info("mcp.save_deal", { caller: mask(entityId), deal: dealId });
      m.bump("deals.saved");
      // The actor adds `itineraryUrl` to the profile when Cloud Storage is
      // configured; surface it back to the model so the caller hears the
      // link on the call (and can read it in the saved-deals list later).
      return toolOk({
        saved: true,
        dealId,
        ...(profile?.itineraryUrl ? { itineraryUrl: profile.itineraryUrl } : {}),
      });
    }),
  );

  server.registerTool(
    "list_saved_deals",
    {
      description: "List the deals the caller has saved on previous calls.",
      inputSchema: {},
    },
    (_args, extra) => guard("list_saved_deals", async () => {
      const conv = conversationId(extra);
      setTraceId(conv || undefined);
      const entityId = await requireCaller(kv, conv);
      const profile = await callActor(actor, entityId, "getSaved");
      info("mcp.list_saved_deals", { caller: mask(entityId) });
      return toolOk(profile);
    }),
  );

  // send_deal_sms — only when an SMS sender is wired (production index.ts).
  // The number is the CALLER's, from the session the webhook wrote; the deal
  // must be one the caller was offered (saveDeal validates it), so the model
  // can neither text a stranger nor invent a link. The KV flag sms_enabled
  // switches it off without a redeploy.
  if (sms) {
    server.registerTool(
      "send_deal_sms",
      {
        description:
          "Text the caller a deal they were just offered (details and booking link). " +
          "Sends to the number they are calling from; the deal is also saved.",
        inputSchema: {
          deal_id: z.string().min(1).max(100).describe("The dealId of a deal from the last search_deals result."),
        },
      },
      (args, extra) => guard("send_deal_sms", async () => {
        const conv = conversationId(extra);
        setTraceId(conv || undefined);
        if (!(await smsEnabled(kv))) throw new ToolError("Text messages are turned off right now.");
        const entityId = await requireCaller(kv, conv);
        const dealId = args.deal_id.trim();
        // `saveDeal` rejects deals the caller was not offered, so the model
        // can neither text a stranger nor invent a link. Its response carries
        // the just-written itinerary URL (when Cloud Storage is configured),
        // which we surface in the SMS body for the caller to tap. We also
        // forward the itinerary/reminder config (live finding, step 11): the
        // actor's umbrella telnyx.toml [env_vars] do not reach actor instances'
        // process.env, so it learns itineraryBaseUrl / smsFrom /
        // messagingProfileId from this call instead.
        const saveResult = (await callActor(actor, entityId, "saveDeal", saveDealBody(dealId))) as
          | { itineraryUrl?: string }
          | undefined;
        const saved = (await callActor(actor, entityId, "getSaved")) as { deals?: Deal[] };
        const deal = saved.deals?.find((d) => d.dealId === dealId);
        if (!deal) throw new ToolError("I couldn't find that deal; please pick one I just read out.");
        let smsText = dealSms(deal);
        if (saveResult?.itineraryUrl) smsText += `\nItinerary: ${saveResult.itineraryUrl}`;
        try {
          await sms.send(`+${entityId}`, smsText);
        } catch (e) {
          error("mcp.sms_failed", { caller: mask(entityId), deal: dealId }, e);
          throw new ToolError("I couldn't send the text message right now; the deal is saved.");
        }
        info("mcp.sms_sent", { caller: mask(entityId), deal: dealId });
        m.bump("sms.sent");
        return toolOk({ sent: true, dealId });
      }),
    );
  }

  return server;
}

// --------------------------------------------------------------- HTTP handler

/** Build the per-request HTTP handler (auth + health + MCP). Closing over
 * `deps` lets tests inject fakes; `index.ts` wires the real Telnyx clients. */
export function createHandler(
  deps: Dependencies,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  // Bearer token expected on every request (MCP_API_KEY secret).
  const expectedToken = `Bearer ${config.require("MCP_API_KEY")}`; // fail at boot if unset
  return (req, res) => {
    // A fresh trace context per request (see log.ts setTraceId).
    traceContext.run({ id: "" }, () => void handleRequest(req, res, deps, expectedToken));
  };
}

/** Handle one HTTP request: health, bearer auth, then a fresh stateless
 * McpServer + transport for the parsed JSON-RPC message. */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: Dependencies,
  expectedToken: string,
): Promise<void> {
  try {
    const pathname = new URL(req.url ?? "/", "http://server").pathname;

    // Health probes (no auth). The platform calls /health/liveness and
    // /health/readiness, so answer /health and every path under it.
    if (pathname === "/health" || pathname.startsWith("/health/")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // Bearer auth FIRST — never let an unsigned request reach the transport.
    if (!safeEqual(req.headers.authorization ?? "", expectedToken)) {
      warning("mcp.unauthorized", { reason: "bearer mismatch" });
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    // Read + parse the JSON-RPC body.
    const raw = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      sendJson(res, 400, { error: "invalid json body" });
      return;
    }
    if (!parsedBody || typeof parsedBody !== "object") {
      sendJson(res, 400, { error: "expected a JSON-RPC object" });
      return;
    }

    // A fresh McpServer + stateless transport per request (Edge has no
    // request lifespan).
    const m = new RequestMetrics();
    const server = createServer(deps.kv, deps.actor, deps.fetchImpl, deps.sms, m);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    // One latency span per JSON-RPC request (tool name for tools/call).
    const rpc = parsedBody as { method?: string; params?: { name?: string } };
    const started = Date.now();
    await transport.handleRequest(req, res, parsedBody);
    const ms = Date.now() - started;
    info("mcp.request", { method: rpc.method, tool: rpc.params?.name, status: res.statusCode, duration_ms: ms });
    // One metrics update per request; only registered tool names become keys.
    const name = rpc.params?.name;
    if (rpc.method === "tools/call" && name && TOOL_NAMES.has(name)) {
      m.bump("mcp.tool_calls");
      m.bump(`tool.${name}`);
      m.latency[`tool.${name}`] = ms;
    }
    if (Object.keys(m.counts).length) deps.metrics?.add(m.counts, m.latency);
  } catch (e) {
    error("mcp.request_failed", undefined, e);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  }
}

/** Constant-time string compare, so response timing does not leak the token. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Collect the request body as a UTF-8 string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Write a small JSON response. */
function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}
