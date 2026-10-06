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
 * WIth nothing hardcoded, the binding name comes from `func.toml`; only the
 * production entry (`index.ts`) constructs an `EdgeKv`. Tests pass a fake
 * `Kv` and never construct this class.
 */

import { env } from "@telnyx/edge-runtime";

import { type Kv, KvError } from "./server";

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
    try {
      return await KV.get(key, { type: "json" });
    } catch (e) {
      throw new KvError(
        `kv get ${JSON.stringify(key)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Store a JSON value at `key`, optionally with a TTL in seconds. */
  async putJson(key: string, value: unknown, ttlSecs?: number): Promise<void> {
    try {
      await KV.put(
        key,
        JSON.stringify(value),
        ttlSecs ? { expirationTtl: ttlSecs } : {},
      );
    } catch (e) {
      throw new KvError(
        `kv put ${JSON.stringify(key)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
