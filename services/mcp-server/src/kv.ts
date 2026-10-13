/**
 * src/kv.ts — thin JSON wrapper over the Telnyx Edge KV binding.
 *
 * Uses `env.KV` (declared as `[storage.kv.KV]` in `func.toml`):
 *   - `getJson(key)`      → `env.KV.get(key, { type: "json" })`
 *                          (returns the parsed JSON value, or undefined for a
 *                           missing key).
 *   - `putJson(key, v, t)`→ `env.KV.put(key, JSON.stringify(v), { expirationTtl: t })`.
 *
 * Any failure is raised as `KvError` so callers can degrade cleanly (the
 * MCP tools treat KV as best-effort cache and best-effort session reads).
 *
 * With nothing hardcoded, the binding name comes from `func.toml`; only the
 * production entry (`index.ts`) constructs an `EdgeKv`. Tests pass a fake
 * `Kv` and never construct this class.
 */

import { env } from "@telnyx/edge-runtime";

import { config } from "./config.js";
import { type Kv, KvError, withTimeoutMs } from "./server.js";

/**
 * Minimal hand-written type for the KV binding. The runtime-generated
 * `telnyx-env.d.ts` would augment the base `Env`; this declaration makes the
 * code compile without codegen while staying structurally compatible with the
 * real binding.
 */
interface EdgeKvNamespace {
  get<T = unknown>(key: string, opts?: { type?: "json" | "text" | "raw" }): Promise<T | undefined>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** `env` cast to a shape that exposes the `KV` binding from `func.toml`. */
const KV = (env as unknown as { KV: EdgeKvNamespace }).KV;

/** Async JSON wrapper over the Telnyx Edge KV binding. */
export class EdgeKv implements Kv {
  /** Return the JSON value at `key`, or `undefined` when missing. */
  async getJson(key: string): Promise<unknown> {
    const ms = config.integer("KV_TIMEOUT_MS", 1500);
    try {
      // Race the binding call against KV_TIMEOUT_MS so a sick/slow KV (live
      // incident, step 29: ~1.2-2.7 s per healthy read, 500s when degraded)
      // cannot stack serial calls and time out the assistant's tool call.
      return await withTimeoutMs(
        KV.get(key, { type: "json" }),
        ms,
        `kv get ${JSON.stringify(key)}`,
      );
    } catch (e) {
      throw new KvError(
        `kv get ${JSON.stringify(key)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Store a JSON value at `key`, optionally with a TTL in seconds. */
  async putJson(key: string, value: unknown, ttlSecs?: number): Promise<void> {
    const ms = config.integer("KV_TIMEOUT_MS", 1500);
    try {
      await withTimeoutMs(
        KV.put(
          key,
          JSON.stringify(value),
          ttlSecs ? { expirationTtl: ttlSecs } : {},
        ),
        ms,
        `kv put ${JSON.stringify(key)}`,
      );
    } catch (e) {
      throw new KvError(
        `kv put ${JSON.stringify(key)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
