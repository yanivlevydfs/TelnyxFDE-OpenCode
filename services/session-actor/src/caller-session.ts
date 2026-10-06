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
 * Why an actor (not KV): all three are read-modify-write per caller; KV is
 * last-write-wins with no compare-and-set, so two concurrent calls from the
 * same caller would race and lose updates. Telnyx serializes each actor
 * instance's method turns one at a time, which is the lock we want for free.
 *
 * Run tests:  cd services/session-actor && npm test
 */

import { localIso } from "./time.js";
import { StatefulActor, type Env } from "@telnyx/edge-runtime";

/** A flight deal kept by the actor. Mirrors the camelCase shape produced
 * by the MCP server's `slim()` (services/mcp-server/src/server.ts) so the
 * JSON stored here is independent of the flytlv.app snake_case contract. */
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

/** Whether v looks structurally like a Deal. Only `dealId` is required to be a
 * string — it is the key we look up by and dedup on. Other fields are passed
 * through to the webhook for greeting text and swallowed as-is if the
 * flytlv.app feed omits them. */
function isDeal(v: unknown): v is Deal {
  return (
    typeof v === "object" && v !== null && typeof (v as Deal).dealId === "string"
  );
}

// --------------------------------------------------------------------- logging

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";
const LEVELS: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

/** One LOG_LEVEL setting per process. Edge pods scale to zero between calls
 * (per AGENTS.md "Functions scale to zero") so a module-level value is fine. */
let logLevel: Level = "INFO";
{
  const envLevel = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  if (envLevel in LEVELS) logLevel = envLevel as Level;
}

/** Override the level (tests). */
export function setLogLevel(level: Level): void {
  if (level in LEVELS) logLevel = level;
}

/** Emit one JSON line per log event to the console (level is also the JSON
 * `level` field so `telnyx-edge logs --json | jq` matches Python services). */
function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const line = JSON.stringify({
    ts: localIso(),
    level,
    service: "session-actor",
    event,
    ...fields,
    // Caller ids are phone digits: log the last 4 only.
    ...(typeof fields.entity === "string" && fields.entity ? { entity: `***${fields.entity.slice(-4)}` } : {}),
  });
  if (level === "ERROR") console.error(line);
  else if (level === "WARNING") console.warn(line);
  else console.log(line);
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
export class CallerSession extends StatefulActor<Env> {
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
   */
  async setLastResults(input: { deals: unknown }): Promise<{ stored: number }> {
    if (!input || !Array.isArray(input.deals)) {
      throw new ActorInputError("deals must be an array");
    }
    for (const d of input.deals) {
      if (!isDeal(d)) {
        throw new ActorInputError("deals must all be Deal objects");
      }
    }
    await this.ctx.storage.put(K_LAST_RESULTS, input.deals);
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
   * Returns the **full profile** so `save_deal` can speak the new
   * `lastSaved` immediately.
   */
  async saveDeal(input: { dealId?: string }): Promise<Profile> {
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
      await this.ctx.storage.put(K_SAVED_DEALS, saved);
    }
    log("INFO", "saveDeal", {
      entity: this.ctx.id,
      dealId,
      savedCount: saved.length,
    });
    return this._profile(
      (await this.ctx.storage.get<number>(K_CALL_COUNT)) ?? 0,
      saved,
    );
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
   * Build the profile snapshot.
   *
   * `callCount` and `saved` are passed in by `recordCall` / `saveDeal` to
   * avoid a duplicate storage read after the very turn that wrote them.
   * `lastSaved` is the last pushed deal (i.e. the deal saved most recently).
   */
  private async _profile(
    callCount: number,
    saved?: Deal[],
  ): Promise<Profile> {
    const deals = saved ?? (await this.ctx.storage.get<Deal[]>(K_SAVED_DEALS)) ?? [];
    return {
      callCount,
      savedCount: deals.length,
      lastSaved: deals.length > 0 ? deals[deals.length - 1] : null,
    };
  }
}
