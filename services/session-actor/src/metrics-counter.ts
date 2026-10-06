/**
 * MetricsCounter — Stateful Actor holding the service-wide metrics.
 *
 * One instance ("global") shared by the webhook and the MCP server. Every
 * request adds counters (calls, outcomes, cache hits, SMS sent, ...) and
 * latency samples. A KV counter would lose increments under concurrent calls
 * (last-write-wins, no compare-and-set); the actor runs one method turn at a
 * time, so each `add` is an atomic read-modify-write. Edge instances scale to
 * zero, so in-memory counters would reset — actor storage is durable.
 *
 *   add({counts, latency})  counts: {name: +n}; latency: {name: milliseconds}
 *   snapshot()              {since, counts, latency: {name: {count, avg_ms, max_ms}}}
 *   reset()                 clear everything (start of a demo)
 */

import { StatefulActor, type Env } from "@telnyx/edge-runtime";

import { ActorInputError } from "./caller-session";

const K_COUNTS = "counts";
const K_LATENCY = "latency";
const K_SINCE = "since";

type Counts = Record<string, number>;
interface LatencyStat {
  n: number;
  sum: number;
  max: number;
}

/** Metric names: short dotted identifiers only (no free text from callers). */
const NAME = /^[a-z0-9_.]{1,64}$/;

function numbers(obj: unknown, what: string): Counts {
  if (obj === undefined) return {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new ActorInputError(`${what} must be an object`);
  }
  const out: Counts = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!NAME.test(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ActorInputError(`${what}.${k} must be a non-negative number`);
    }
    out[k] = v;
  }
  return out;
}

export class MetricsCounter extends StatefulActor<Env> {
  async add(input: { counts?: unknown; latency?: unknown }): Promise<{ ok: true }> {
    const counts = numbers(input?.counts, "counts");
    const latency = numbers(input?.latency, "latency");

    const stored = (await this.ctx.storage.get<Counts>(K_COUNTS)) ?? {};
    for (const [k, v] of Object.entries(counts)) stored[k] = (stored[k] ?? 0) + v;
    await this.ctx.storage.put(K_COUNTS, stored);

    if (Object.keys(latency).length) {
      const lat = (await this.ctx.storage.get<Record<string, LatencyStat>>(K_LATENCY)) ?? {};
      for (const [k, ms] of Object.entries(latency)) {
        const s = lat[k] ?? { n: 0, sum: 0, max: 0 };
        lat[k] = { n: s.n + 1, sum: s.sum + ms, max: Math.max(s.max, ms) };
      }
      await this.ctx.storage.put(K_LATENCY, lat);
    }
    if (!(await this.ctx.storage.get<string>(K_SINCE))) {
      await this.ctx.storage.put(K_SINCE, new Date().toISOString());
    }
    return { ok: true };
  }

  async snapshot(): Promise<{
    since: string | null;
    counts: Counts;
    latency: Record<string, { count: number; avg_ms: number; max_ms: number }>;
  }> {
    const lat = (await this.ctx.storage.get<Record<string, LatencyStat>>(K_LATENCY)) ?? {};
    const latency: Record<string, { count: number; avg_ms: number; max_ms: number }> = {};
    for (const [k, s] of Object.entries(lat)) {
      latency[k] = { count: s.n, avg_ms: Math.round(s.sum / Math.max(s.n, 1)), max_ms: Math.round(s.max) };
    }
    return {
      since: (await this.ctx.storage.get<string>(K_SINCE)) ?? null,
      counts: (await this.ctx.storage.get<Counts>(K_COUNTS)) ?? {},
      latency,
    };
  }

  async reset(): Promise<{ ok: true }> {
    await this.ctx.storage.put(K_COUNTS, {});
    await this.ctx.storage.put(K_LATENCY, {});
    await this.ctx.storage.put(K_SINCE, new Date().toISOString());
    return { ok: true };
  }
}
