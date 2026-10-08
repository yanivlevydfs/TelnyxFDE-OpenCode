/**
 * CallerSession — Stateful Actor for per-caller state.
 *
 * One actor instance per caller (keyed by the digits of their phone number),
 * owning three pieces of state that need atomic read-modify-write:
 *
 *   - `callCount`   — incremented on every webhook fire (one per call). The
 *                     webhook reads it back to say "welcome back, this is your
 *                     Nth call".
 *   - `lastResults` — the deals the MCP `search_deals` tool last returned to
 *                     this caller, so `save_deal` can resolve a `dealId` to a
 *                     trusted `Deal` object — the model cannot invent one.
 *   - `savedDeals`  — append-only set of deals the caller saved, deduped by id.
 *                     The webhook reads `savedDeals` (via `lastSaved`) to say
 *                     "welcome back, last time you saved Larnaca for 64 dollars".
 *
 * Plus a bounded `searchHistory` timeline of search + save events (step 20),
 * readable via `getHistory()`, with an immutable copy of each event written to
 * Cloud Storage as an audit record.
 *
 * Why an actor (not KV): all three are read-modify-write per caller; KV is
 * last-write-wins with no compare-and-set, so two concurrent calls from the
 * same caller would race and lose updates. Telnyx serializes each actor
 * instance's method turns one at a time, which is the lock we want for free.
 *
 * `saveDeal` also writes a small itinerary HTML page to Telnyx Cloud Storage
 * (`env.ITINERARIES`) and schedules a follow-up SMS reminder via the actor's
 * single alarm. Both are best-effort: if the bucket binding, the alarm or the
 * public URL base is missing, the save still succeeds — only `itineraryUrl`
 * is dropped from the returned profile (AGENTS.md step 7).
 *
 * Run tests:  cd services/session-actor && npm test
 */

import { randomUUID } from "node:crypto";

import { log, localIso, mask } from "./log.js";
import {
  StatefulActor,
  type AlarmInfo,
  type CloudStorageBucket,
  type CloudStorageObjectBody,
  type Env,
} from "@telnyx/edge-runtime";

/** A flight deal kept by the actor: the required core of the MCP server's
 * `slim()` output (services/mcp-server/src/server.ts). Extra fields (airports,
 * legs, nights) are stored as sent; only these are validated. */
export interface Deal {
  /** Stable upstream deal id (used to dedup saved deals). */
  dealId: string;
  city: string;
  country: string;
  price: number;
  currency: string;
  departureDate: string;
  returnDate: string;
  airline: string;
  /** Direct flight (no connections). */
  direct: boolean;
  /** Booking URL on flytlv.app. */
  url: string;
}

/** A snapshot of the caller's history used by the webhook for greetings and
 * for `last_saved_deal` ("welcome back, you saved …"). `lastSaved` is the
 * most-recently-saved deal, or `null` if none. */
export interface Profile {
  /** Total calls from this caller. */
  callCount: number;
  /** Number of saved deals (deduped). */
  savedCount: number;
  /** The most recently saved deal, or `null`. */
  lastSaved: Deal | null;
  /** Public URL of the itinerary page written by `saveDeal`. Set only when
   * Cloud Storage (`env.ITINERARIES`), the alarm and `ITINERARY_BASE_URL`
   * are all configured; absent otherwise. The webhook passes it through;
   * the MCP `save_deal` / `send_deal_sms` tools surface it to the model. */
  itineraryUrl?: string;
}

/** Thrown by actor methods when caller-supplied input is invalid (missing
 * `dealId`, `dealId` not present in the last search results, malformed
 * `setLastResults` payload). The HTTP facade maps this to `400 {error}`;
 * anything else becomes `500` so a genuine bug is not indistinguishable from
 * a bad request (DECISIONS #8). */
export class ActorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorInputError";
  }
}

// ---------------------------------------------------------------- storage keys

const K_CALL_COUNT = "callCount";
const K_LAST_RESULTS = "lastResults";
const K_SAVED_DEALS = "savedDeals";
/** map<dealId, itinerary storage key> — re-saving a deal reuses its file. */
const K_ITINERARY_KEYS = "itineraryKeys";
/** Pending follow-up reminder consumed by `alarm()`. */
const K_PENDING_REMINDER = "pendingReminder";
/** Per-caller timeline of search + save events (capped by SEARCH_HISTORY_MAX). */
const K_SEARCH_HISTORY = "searchHistory";

/**
 * One entry in the caller's history timeline. `search` entries come from
 * `setLastResults` (the query the model ran + result count + up to 3 deal ids);
 * `save` entries come from `saveDeal`. Together they answer "what did this
 * caller look for (destinations, dates, flights) and when?" — readable via
 * `getHistory()` and audited to Cloud Storage by `_writeAudit`.
 */
export interface HistoryEntry {
  /** Epoch millis when the event happened. */
  ts: number;
  /** Telnyx conversation id (empty when unknown). */
  conversationId?: string;
  /** `"search"` (setLastResults) or `"save"` (saveDeal). */
  type: "search" | "save";
  /** For "search": the query exactly as search_deals received it. */
  query?: Record<string, unknown>;
  /** For "search": how many deals came back. */
  resultCount?: number;
  /** For "search": up to 3 deal ids from the top of the results. */
  topDealIds?: string[];
  /** For "save": the saved deal id. */
  dealId?: string;
}

/** Whether v looks structurally like a Deal. Only `dealId` is required to be a
 * string — it is the key we look up by and dedup on. Other fields are passed
 * through to the webhook for greeting text and swallowed as-is if the
 * flytlv.app feed omits them. */
function isDeal(v: unknown): v is Deal {
  return (
    typeof v === "object" && v !== null && typeof (v as Deal).dealId === "string"
  );
}

/**
 * Per-call config the MCP server forwards to `saveDeal` because the actor's
 * umbrella `telnyx.toml` `[env_vars]` do NOT reach actor instances'
 * `process.env` (live finding, step 11, 7 Oct 08:52 UTC: `itinerary_skipped
 * reason=noITINERARY_BASE_URL`). Each value is resolved as
 * `input.config.X ?? process.env.X`; bad-typed ones are ignored. Exported so
 * `src/index.ts`'s dispatch can type the `saveDeal` body.
 */
export interface SaveDealConfig {
  /** Public prefix for itinerary pages: `${itineraryBaseUrl}/itineraries/<uuid>.html`. */
  itineraryBaseUrl?: string;
  /** Delay before the follow-up reminder SMS fires, in seconds (positive). */
  reminderDelaySeconds?: number;
  /** Alphanumeric Telnyx messaging sender id, captured for `alarm()`. */
  smsFrom?: string;
  /** Telnyx messaging profile id, captured for `alarm()`. */
  messagingProfileId?: string;
}

/** Resolved string config value: `cfg` (when a non-empty trimmed string),
 * else `process.env[name]` (when a non-empty trimmed string), else
 * `undefined`. Bad-typed values (numbers, objects…) are dropped; an empty /
 * whitespace-only string counts as bad — the actor never writes a "config"
 * without a value behind it. */
function pickString(v: unknown, name: string): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    if (s) return s;
  }
  const env = process.env[name];
  if (typeof env === "string") {
    const s = env.trim();
    if (s) return s;
  }
  return undefined;
}

/** Resolved positive-number reminder delay: `cfg` (when a finite positive
 * number), else `process.env[name]` parsed as a number (when finite &
 * positive), else `def`. Anything else (strings in `cfg`, unparseable or
 * non-positive env values, …) is ignored so a bad config never disrupts the
 * alarm. */
function pickPositiveNumber(v: unknown, name: string, def: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  const env = process.env[name];
  if (typeof env === "string") {
    const s = env.trim();
    if (s) {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return def;
}

/** Map a caller id (actor id = digits) for the audit trail: `***` + last 4
 * digits — reuses the shared `mask` helper from `log.ts` (the same mask used
 * on every log line). The full phone number is never written to Cloud Storage. */
function maskCaller(id: string): string {
  return mask(id);
}

/** Audit Cloud Storage key prefix (env `AUDIT_PREFIX`, default "audit/").
 * In production the actor's umbrella `[env_vars]` do not reach actor instances
 * (live finding, step 11), so this defaults to "audit/" there; the bucket
 * binding (`env.ITINERARIES`) does reach the actor, so writes still happen. */
function auditPrefix(): string {
  const v = process.env.AUDIT_PREFIX;
  if (typeof v === "string" && v.trim()) return v.trim().replace(/\/?$/, "/");
  return "audit/";
}

/** Max entries kept in `searchHistory` (env `SEARCH_HISTORY_MAX`, default 50).
 * Bad-typed / non-positive values fall back to the default. */
function searchHistoryMax(): number {
  const v = process.env.SEARCH_HISTORY_MAX;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 50;
}

// ----------------------------------------------- actor Env binding types

/** Subset of the pre-authenticated Telnyx SDK client (`env.TELNYX`) used by
 * the follow-up reminder; `messages.send` is the only call `alarm()` makes. */
interface TelnyxMessages {
  messages: {
    send(body: {
      from: string;
      to: string;
      text: string;
      messaging_profile_id: string;
    }): Promise<unknown>;
  };
}

/** Bindings declared for this actor in `telnyx.toml`:
 *   - `TELNYX`      — pre-authenticated Telnyx SDK client (`[telnyx] binding`)
 *                     used by `alarm()` to send the follow-up SMS.
 *   - `ITINERARIES` — Cloud Storage bucket for itinerary HTML files
 *                     (`[storage.cloudstorage.ITINERARIES]`). */
export interface SessionActorEnv extends Env {
  TELNYX?: TelnyxMessages;
  ITINERARIES?: CloudStorageBucket;
}

/** Pending reminder written by `saveDeal` and consumed by `alarm()`. */
interface PendingReminder {
  dealId: string;
  itineraryUrl: string;
  /** Reminder SMS sender id resolved at `saveDeal` time (from the call `config`
   * or `process.env.SMS_FROM`). Captured into storage because the actor's
   * `alarm()` may not see the same `process.env` at fire time (live finding,
   * step 11). Absent → `alarm()` falls back to `process.env.SMS_FROM`. */
  smsFrom?: string;
  /** Reminder messaging profile id resolved at `saveDeal` time, same as
   * `smsFrom`. Absent → `alarm()` falls back to `process.env.MESSAGING_PROFILE_ID`. */
  messagingProfileId?: string;
}

// --------------------------------------------------------------- the actor

/**
 * CallerSession — one actor instance per caller (digits of the phone).
 *
 * Lifecycle: `env.CALLER_SESSION.idFromName(callerId)` materialises a stub on
 * first use; Telnyx routes every call from the same caller to the same
 * actor instance, ordering method calls one at a time so read-modify-write
 * of `callCount` and `savedDeals` is safe without any external lock.
 */
export class CallerSession extends StatefulActor<SessionActorEnv> {
  /**
   * Increment the per-caller call counter.
   *
   * Returns the **full profile** (`callCount`, `savedCount`, `lastSaved`) so
   * the webhook builds all of `call_count`, `saved_count` and
   * `last_saved_deal` ("welcome back, you saved …") from this one response
   * — see the webhook ↔ actor contract in AGENTS.md.
   */
  async recordCall(): Promise<Profile> {
    const count = (await this.ctx.storage.get<number>(K_CALL_COUNT)) ?? 0;
    const next = count + 1;
    await this.ctx.storage.put(K_CALL_COUNT, next);
    log("INFO", "recordCall", { entity: this.ctx.id, callCount: next });
    return this._profile(next);
  }

  /** Read-only profile snapshot (no increment). */
  async getProfile(): Promise<Profile> {
    const count = (await this.ctx.storage.get<number>(K_CALL_COUNT)) ?? 0;
    return this._profile(count);
  }

  /**
   * Replace the last search results kept in the actor, so `save_deal` can
   * resolve a `dealId` to a trusted `Deal` object. Used by the MCP
   * `search_deals` tool after every flytlv.app response.
   *
   * Rejects (`ActorInputError`) when `deals` is not an array or contains an
   * entry whose `dealId` is not a string — the actor only trusts what it
   * stored, so a malformed upload fails loudly instead of letting
   * `save_deal` match against garbage.
   *
   * When `query` and `conversationId` are present, appends a `search` entry to
   * the caller's history timeline (`searchHistory`, capped by
   * `SEARCH_HISTORY_MAX`, default 50) and writes an immutable audit JSON
   * object to Cloud Storage. Both are best-effort and never fail the call.
   */
  async setLastResults(input: {
    deals: unknown;
    query?: unknown;
    conversationId?: unknown;
  }): Promise<{ stored: number }> {
    if (!input || !Array.isArray(input.deals)) {
      throw new ActorInputError("deals must be an array");
    }
    for (const d of input.deals) {
      if (!isDeal(d)) {
        throw new ActorInputError("deals must all be Deal objects");
      }
    }
    await this.ctx.storage.put(K_LAST_RESULTS, input.deals);

    // Per-caller search history + audit (step 20). `query` is the search_deals
    // args exactly as received; `conversationId` ties the event to a Telnyx
    // conversation (also the audit path segment). Bad types are ignored so they
    // can never break a search.
    const query = typeof input.query === "object" && input.query !== null &&
      !Array.isArray(input.query)
      ? (input.query as Record<string, unknown>)
      : undefined;
    const conversationId = typeof input.conversationId === "string" && input.conversationId.length > 0
      ? input.conversationId
      : undefined;
    const topDealIds = input.deals
      .slice(0, 3)
      .map((d) => (d as Deal).dealId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const entry: HistoryEntry = {
      ts: Date.now(),
      type: "search",
      ...(conversationId ? { conversationId } : {}),
      ...(query ? { query } : {}),
      resultCount: input.deals.length,
      ...(topDealIds.length ? { topDealIds } : {}),
    };
    await this._appendHistory(entry);
    await this._writeAudit(entry);

    log("INFO", "setLastResults", {
      entity: this.ctx.id,
      count: input.deals.length,
    });
    return { stored: input.deals.length };
  }

  /**
   * Save a deal from the last search results, by `dealId`.
   *
   * Rejects (`ActorInputError`) on:
   *   - `dealId` missing/empty
   *   - no last search results containing that `dealId`
   *
   * Deduplicated: re-saving the same `dealId` is a no-op (`savedCount` stable)
   * so a caller tapping "save" twice on the same deal does not double-count.
   *
   * Best-effort side-effects (never break a save): write a small itinerary
   * HTML page to `env.ITINERARIES` (reusing the existing key for this
   * `dealId`), and schedule a single follow-up SMS reminder via the actor's
   * alarm. If the bucket binding, `setAlarm` or `ITINERARY_BASE_URL` is
   * missing, log a WARNING and still return the profile — without
   * `itineraryUrl` (AGENTS.md step 7). One alarm per actor: a newer save
   * replaces the pending reminder.
   *
   * `config` is the per-call override the MCP server forwards (live finding,
   * step 11: the actor's umbrella `telnyx.toml` `[env_vars]` do not reach
   * actor instances' `process.env`). Each field is resolved as
   * `config.X ?? process.env.X`; bad-typed values are ignored. The resolved
   * `smsFrom` / `messagingProfileId` are captured into the pending reminder
   * so `alarm()` reads them from storage (no longer relying on `process.env`
   * at fire time).
   *
   * Returns the **full profile** so `save_deal` can speak the new
   * `lastSaved` immediately; `itineraryUrl` is present when the side-effects
   * all succeeded.
   */
  async saveDeal(input: {
    dealId?: string;
    config?: SaveDealConfig;
    conversationId?: unknown;
  }): Promise<Profile> {
    const dealId = input?.dealId;
    if (typeof dealId !== "string" || dealId.length === 0) {
      throw new ActorInputError("dealId is required");
    }
    const last = (await this.ctx.storage.get<Deal[]>(K_LAST_RESULTS)) ?? [];
    const found = last.find((d) => d.dealId === dealId);
    if (!found) {
      throw new ActorInputError(
        `deal ${dealId} not found in last search results`,
      );
    }
    const saved = (await this.ctx.storage.get<Deal[]>(K_SAVED_DEALS)) ?? [];
    if (!saved.some((d) => d.dealId === dealId)) {
      saved.push(found);
      // Bounded: keep the newest MAX_SAVED_DEALS (actor storage is not a database).
      const max = Number(process.env.MAX_SAVED_DEALS ?? 50);
      await this.ctx.storage.put(K_SAVED_DEALS, saved.slice(-max));
    }

    // Itinerary file + reminder side-effects. Aggregated into `itineraryUrl`,
    // which the profile surfaces only when every required binding/env var
    // is present and the writes/alarms succeed. The per-call `config`
    // overrides process.env (live finding, step 11).
    const itineraryUrl = await this._writeItineraryAndScheduleReminder(
      found,
      input?.config,
    );

    // Per-caller save history + audit (step 20). Appended on every saveDeal
    // call (including re-saves) so the timeline reflects every save attempt;
    // the conversation id ties it to a Telnyx conversation. Best-effort.
    const conversationId = typeof input?.conversationId === "string" && input.conversationId.length > 0
      ? input.conversationId
      : undefined;
    const saveEntry: HistoryEntry = {
      ts: Date.now(),
      type: "save",
      ...(conversationId ? { conversationId } : {}),
      dealId,
    };
    await this._appendHistory(saveEntry);
    await this._writeAudit(saveEntry);

    log("INFO", "saveDeal", {
      entity: this.ctx.id,
      dealId,
      savedCount: saved.length,
      itinerary: Boolean(itineraryUrl),
    });
    return this._profile(
      (await this.ctx.storage.get<number>(K_CALL_COUNT)) ?? 0,
      saved,
      itineraryUrl,
    );
  }

  /**
   * Render the itinerary page for `deal`, `put` it into `env.ITINERARIES`
   * (reusing the existing key for this `dealId`), record the pending
   * reminder and arm the alarm. All best-effort: returns `undefined` when
   * any prerequisite is missing or fails, so a save never breaks.
   *
   * `cfg` is the per-call config the MCP server forwards (live finding,
   * step 11). Each value is resolved as `cfg.X ?? process.env.X` (validated,
   * bad ones ignored); the resolved `smsFrom` / `messagingProfileId` are
   * stored on the pending reminder so `alarm()` reads them back from storage
   * (it can no longer rely on `process.env` at fire time).
   *
   * ponytail: one alarm per actor — a newer save replaces the pending
   * reminder, so the last save wins. If a caller accumulates many saved
   * deals and we want a reminder per deal, move scheduling into a CronTick
   * actor sharded by interval bucket; this actor would only enqueue work.
   */
  private async _writeItineraryAndScheduleReminder(
    deal: Deal,
    cfg?: SaveDealConfig,
  ): Promise<string | undefined> {
    const bucket = this.env.ITINERARIES;
    const baseUrl = pickString(cfg?.itineraryBaseUrl, "ITINERARY_BASE_URL");
    const hasAlarm = typeof this.ctx.storage.setAlarm === "function";
    if (!bucket || !baseUrl || !hasAlarm) {
      log("WARNING", "itinerary_skipped", {
        entity: this.ctx.id,
        reason: !bucket ? "noITINERARIES" : !baseUrl ? "noITINERARY_BASE_URL" : "noSetAlarm",
        dealId: deal.dealId,
      });
      return undefined;
    }

    // reuse the existing storage key for this deal (one file per saved deal)
    const map =
      (await this.ctx.storage.get<Record<string, string>>(K_ITINERARY_KEYS)) ?? {};
    let key = map[deal.dealId];
    if (!key) {
      key = `itineraries/${randomUUID()}.html`;
      map[deal.dealId] = key;
      await this.ctx.storage.put(K_ITINERARY_KEYS, map);
    }
    try {
      await bucket.put(key, renderItinerary(deal), {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
    } catch (e) {
      log("WARNING", "itinerary_write_failed", {
        entity: this.ctx.id,
        dealId: deal.dealId,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
    const itineraryUrl = `${baseUrl}/${key}`;

    // Resolve the reminder config once: per-call `config` first, then
    // `process.env` (validated). Captured into the pending reminder so the
    // `alarm()` turn does not depend on `process.env` — which the actor
    // umbrella [env_vars] do not honour (live finding, step 11).
    const smsFrom = pickString(cfg?.smsFrom, "SMS_FROM");
    const messagingProfileId = pickString(
      cfg?.messagingProfileId,
      "MESSAGING_PROFILE_ID",
    );
    const reminderDelaySeconds = pickPositiveNumber(
      cfg?.reminderDelaySeconds,
      "REMINDER_DELAY_SECONDS",
      600,
    );

    // Schedule the follow-up SMS. The pending reminder is what alarm() reads
    // back, so it (not the alarm-time snapshot) is the source of truth.
    try {
      await this.ctx.storage.put(K_PENDING_REMINDER, {
        dealId: deal.dealId,
        itineraryUrl,
        // Captured at save time so alarm() reads them from storage:
        ...(smsFrom ? { smsFrom } : {}),
        ...(messagingProfileId ? { messagingProfileId } : {}),
      } satisfies PendingReminder);
      const delay = reminderDelaySeconds * 1000;
      await this.ctx.storage.setAlarm(Date.now() + delay);
      log("INFO", "reminder_scheduled", {
        entity: this.ctx.id,
        dealId: deal.dealId,
        delay_ms: delay,
      });
    } catch (e) {
      log("WARNING", "alarm_schedule_failed", {
        entity: this.ctx.id,
        dealId: deal.dealId,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
    return itineraryUrl;
  }

  /**
   * Return the caller's saved deals (used by the `list_saved_deals` MCP
   * tool). The deals array is preserved in the caller's order of saving.
   */
  async getSaved(): Promise<{ savedCount: number; deals: Deal[] }> {
    const saved = (await this.ctx.storage.get<Deal[]>(K_SAVED_DEALS)) ?? [];
    return { savedCount: saved.length, deals: saved };
  }

  /**
   * Return the caller's history timeline (search + save events), newest last.
   * Read by the HTTP facade's `getHistory` route and `scripts/ops/history.py`.
   * The actor serializes turns, so this is a consistent snapshot.
   */
  async getHistory(): Promise<{ history: HistoryEntry[] }> {
    const history = (await this.ctx.storage.get<HistoryEntry[]>(K_SEARCH_HISTORY)) ?? [];
    return { history };
  }

  /**
   * Append one entry to the caller's `searchHistory`, capped by
   * `SEARCH_HISTORY_MAX` (default 50, oldest dropped). The cap keeps actor
   * storage bounded — the full audit trail lives in Cloud Storage (see
   * `_writeAudit`); `searchHistory` is the quick in-actor read for history.
   */
  private async _appendHistory(entry: HistoryEntry): Promise<void> {
    const history = (await this.ctx.storage.get<HistoryEntry[]>(K_SEARCH_HISTORY)) ?? [];
    history.push(entry);
    await this.ctx.storage.put(K_SEARCH_HISTORY, history.slice(-searchHistoryMax()));
  }

  /**
   * Write one immutable audit JSON object per event to the existing
   * `env.ITINERARIES` Cloud Storage bucket under
   * `${AUDIT_PREFIX}<YYYY-MM-DD>/<conversationId>/<ts>-<type>.json`. The
   * object holds the event plus a **masked caller** (never the full number).
   *
   * Best-effort: a missing bucket logs a `WARNING` (audit skipped) and a
   * failed write logs `ERROR` with the stack — neither ever fails the tool
   * call. `alarm()` is untouched (per the step-20 spec).
   */
  private async _writeAudit(entry: HistoryEntry): Promise<void> {
    const bucket = this.env.ITINERARIES;
    if (!bucket) {
      log("WARNING", "audit_skipped", {
        entity: this.ctx.id,
        type: entry.type,
        reason: "noITINERARIES",
      });
      return;
    }
    try {
      const date = localIso().slice(0, 10); // YYYY-MM-DD in LOG_TIMEZONE
      const conv = entry.conversationId || "unknown";
      const key = `${auditPrefix()}${date}/${conv}/${entry.ts}-${entry.type}.json`;
      const body = JSON.stringify({ ...entry, caller: maskCaller(this.ctx.id) });
      await bucket.put(key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      log("INFO", "audit_written", {
        entity: this.ctx.id,
        type: entry.type,
        key,
      });
    } catch (e) {
      // A failed audit write must never fail the tool call.
      log("ERROR", "audit_write_failed", {
        entity: this.ctx.id,
        type: entry.type,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  }

  /**
   * Follow-up reminder: re-read the pending reminder (at-least-once
   * delivery — return if none), send one SMS to `+<actor id digits>` through
   * `env.TELNYX.messages.send`, then delete the pending reminder so a
   * redrive sends nothing.
   *
   * Never throws: an uncaught alarm turn is dropped after 3 redrives, so a
   * throw would silently lose the reminder. Any failure is logged `ERROR`
   * with the stack; the reminder is left in place for a redrive unless the
   * SMS actually succeeds (or no caller-side config could ever produce one).
   */
  override async alarm(_info: AlarmInfo): Promise<void> {
    let reminder: PendingReminder | undefined;
    try {
      reminder = await this.ctx.storage.get<PendingReminder>(K_PENDING_REMINDER);
      if (!reminder) return; // at-least-once: a duplicate fire after we deleted
      const rem: PendingReminder = reminder; // narrow across the awaits below
      const saved = (await this.ctx.storage.get<Deal[]>(K_SAVED_DEALS)) ?? [];
      const deal = saved.find((d) => d.dealId === rem.dealId);
      if (!deal) {
        await this.ctx.storage.delete(K_PENDING_REMINDER);
        log("WARNING", "alarm.deal_missing", {
          entity: this.ctx.id,
          dealId: rem.dealId,
        });
        return;
      }
      const client = this.env.TELNYX;
      // Read the SMS identity captured at save time first (the actor's
      // `alarm()` turn cannot rely on `process.env` — the umbrella
      // telnyx.toml [env_vars] do not reach actor instances, live finding
      // step 11 — so saveDeal stores these on the pending reminder); fall
      // back to process.env for unit tests / local dev.
      const smsFrom = rem.smsFrom ?? process.env.SMS_FROM;
      const profileId = rem.messagingProfileId ?? process.env.MESSAGING_PROFILE_ID;
      if (!client || !smsFrom || !profileId) {
        // No way to ever deliver — drop the reminder so the alarm stops.
        await this.ctx.storage.delete(K_PENDING_REMINDER);
        log("WARNING", "alarm.sms_config_missing", {
          entity: this.ctx.id,
          dealId: rem.dealId,
        });
        return;
      }
      const text =
        `Still thinking about ${deal.city} for ${deal.price} ${deal.currency}? ` +
        `Your itinerary: ${rem.itineraryUrl}`;
      await client.messages.send({
        from: smsFrom,
        to: `+${this.ctx.id}`,
        text,
        messaging_profile_id: profileId,
      });
      await this.ctx.storage.delete(K_PENDING_REMINDER);
      log("INFO", "alarm.sms_sent", {
        entity: this.ctx.id,
        dealId: rem.dealId,
      });
    } catch (e) {
      // Never throw from alarm() (a throw loses the alarm after 3 redrives).
      // Leave the reminder in place for a redrive when the SMS itself failed;
      // drain the reminder only if we deleted it above.
      log("ERROR", "alarm.failed", {
        entity: this.ctx.id,
        dealId: reminder?.dealId,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  }

  /**
   * Build the profile snapshot.
   *
   * `callCount` and `saved` are passed in by `recordCall` / `saveDeal` to
   * avoid a duplicate storage read after the very turn that wrote them.
   * `lastSaved` is the last pushed deal (i.e. the deal saved most recently).
   * `itineraryUrl` is included only when `saveDeal` wrote the itinerary file.
   */
  private async _profile(
    callCount: number,
    saved?: Deal[],
    itineraryUrl?: string,
  ): Promise<Profile> {
    const deals =
      saved ?? (await this.ctx.storage.get<Deal[]>(K_SAVED_DEALS)) ?? [];
    return {
      callCount,
      savedCount: deals.length,
      lastSaved: deals.length > 0 ? deals[deals.length - 1] : null,
      ...(itineraryUrl ? { itineraryUrl } : {}),
    };
  }
}

// ----------------------------------------------------------- itinerary HTML

/** HTML-escape a string for safe text/attribute interpolation. The entity
 * strings are built from char codes so they cannot be re-decoded along the
 * tool path (an `&` written as a literal would otherwise be un-escaped). */
function escapeHtml(s: string): string {
  const AMP = String.fromCharCode(0x26, 0x61, 0x6d, 0x70, 0x3b);   // "&"
  const LT = String.fromCharCode(0x26, 0x6c, 0x74, 0x3b);          // "<"
  const GT = String.fromCharCode(0x26, 0x67, 0x74, 0x3b);          // ">"
  const QUOT = String.fromCharCode(0x26, 0x71, 0x75, 0x6f, 0x74, 0x3b); // """
  const APOS = String.fromCharCode(0x26, 0x23, 0x33, 0x39, 0x3b);  // "&#39;"
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return AMP;
      case "<":
        return LT;
      case ">":
        return GT;
      case '"':
        return QUOT;
      default:
        return APOS;
    }
  });
}

/** Stringify + HTML-escape any value (numbers, undefined → ""). */
function text(v: unknown): string {
  return escapeHtml(String(v ?? ""));
}

/**
 * Render a small, mobile-friendly HTML itinerary page for one saved deal.
 * Every deal field is escaped (text and the booking-link `href`), so a deal
 * with a quote in its city name or a stray `<` in its URL cannot break the
 * page or inject markup. The page reshows the booking link so the caller can
 * tap to book from the SMS reminder.
 */
export function renderItinerary(d: Deal): string {
  const dep = text(d.departureDate);
  const ret = text(d.returnDate);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlyTLV — ${text(d.city)}, ${text(d.country)}</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a}
  main{max-width:34rem;margin:1.5rem auto;padding:1.25rem;background:#fff;border-radius:0.75rem;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  h1{margin:0 0 .5rem;font-size:1.45rem}
  .row{display:flex;justify-content:space-between;gap:1rem;margin:.45rem 0}
  .label{color:#475569}
  .value{font-weight:600;text-align:right}
  .book{display:inline-block;margin-top:.85rem;padding:.7rem 1rem;background:#0ea5e9;color:#fff;border-radius:.5rem;text-decoration:none}
</style>
</head>
<body>
<main>
<h1>✈️ ${text(d.city)}, ${text(d.country)}</h1>
<p class="row"><span class="label">Airline</span><span class="value">${text(d.airline)}</span></p>
<p class="row"><span class="label">Departure</span><span class="value"><time datetime="${dep}">${dep}</time></span></p>
<p class="row"><span class="label">Return</span><span class="value"><time datetime="${ret}">${ret}</time></span></p>
<p class="row"><span class="label">Stops</span><span class="value">${d.direct ? "Direct" : "With stops"}</span></p>
<p class="row"><span class="label">Price</span><span class="value">${text(d.price)} ${text(d.currency)}</span></p>
<a class="book" href="${text(d.url)}" rel="noopener noreferrer">Book this flight</a>
</main>
</body>
</html>`;
}
