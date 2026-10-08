/**
 * AuditLog — Stateful Actor holding the service-wide audit trail.
 *
 * One instance ("global") shared by all CallerSession actors. Each event
 * (a search or a save) is sent here via the `AUDIT_LOG` binding; the actor
 * keeps the last `AUDIT_MAX_EVENTS` (env, default 200) in its own storage
 * (single-threaded, no lost events) and **overwrites** the single object
 * `audit/latest.json` in the Cloud Storage bucket after each append.
 *
 * Why an actor and not per-event objects: the `flytlv-itineraries` bucket
 * has a hard account limit of 5 objects (owner, 2026-10-08). Writing one
 * object per event would hit `TooManyObjects` after 5 events. One
 * singleton actor that buffers events in durable storage and overwrites a
 * single audit object keeps the bucket at exactly 4 itinerary slots +
 * 1 audit = 5 objects forever. The actor serializes turns so concurrent
 * appends never lose events (decision #34).
 *
 * A failed audit write logs `ERROR` with the stack and never fails the
 * caller's tool call — the audit is best-effort.
 */

import {
  StatefulActor,
  type CloudStorageBucket,
  type Env,
} from "@telnyx/edge-runtime";

import { log } from "./log.js";
import type { HistoryEntry } from "./caller-session";

// ---------------------------------------------------------------- storage keys

const K_EVENTS = "events";

/** The single Cloud Storage key the audit log overwrites on every append. */
const AUDIT_KEY = "audit/latest.json";

/** Max events kept in actor storage (env `AUDIT_MAX_EVENTS`, default 200).
 * Bad-typed / non-positive values fall back to the default. */
function auditMaxEvents(): number {
  const v = process.env.AUDIT_MAX_EVENTS;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 200;
}

/** Bindings declared for this actor in `telnyx.toml`:
 *   - `ITINERARIES` — Cloud Storage bucket (same one CallerSession writes
 *                     itinerary pages into); the audit log overwrites
 *                     `audit/latest.json` here. */
export interface AuditLogEnv extends Env {
  ITINERARIES?: CloudStorageBucket;
}

/** One audited event: the history entry plus a masked caller id. */
export interface AuditEvent extends HistoryEntry {
  /** `***<last4>` — the full phone number is never written to Cloud Storage. */
  caller?: string;
}

// ----------------------------------------------------------------- the actor

/**
 * AuditLog — one `global` instance, called by every CallerSession actor.
 *
 * Lifecycle: `env.AUDIT_LOG.idFromName("global")` materialises the single
 * instance; Telnyx serializes turns so concurrent appends are safe.
 */
export class AuditLog extends StatefulActor<AuditLogEnv> {
  /**
   * Append one audited event, cap the in-storage buffer to the last
   * `AUDIT_MAX_EVENTS`, and **overwrite** `audit/latest.json` in the bucket.
   *
   * Best-effort: a missing bucket logs `WARNING`; a failed write logs
   * `ERROR` with the stack. Never throws — the caller's tool call must
   * never fail because of the audit.
   */
  async append(input: {
    event: HistoryEntry;
    caller: string;
  }): Promise<{ ok: true }> {
    const bucket = this.env.ITINERARIES;
    if (!bucket) {
      log("WARNING", "audit_skipped", {
        reason: "noITINERARIES",
        type: input.event.type,
      });
      return { ok: true };
    }
    try {
      const events =
        (await this.ctx.storage.get<AuditEvent[]>(K_EVENTS)) ?? [];
      const auditEvent: AuditEvent = { ...input.event, caller: input.caller };
      events.push(auditEvent);
      const max = auditMaxEvents();
      const capped = events.slice(-max);
      await this.ctx.storage.put(K_EVENTS, capped);
      const body = JSON.stringify({
        updated: Date.now(),
        count: capped.length,
        events: capped,
      });
      await bucket.put(AUDIT_KEY, body, {
        httpMetadata: { contentType: "application/json" },
      });
      log("INFO", "audit_written", {
        type: input.event.type,
        count: capped.length,
        key: AUDIT_KEY,
      });
    } catch (e) {
      log("ERROR", "audit_write_failed", {
        type: input.event.type,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
    return { ok: true };
  }
}
