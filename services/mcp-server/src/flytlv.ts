/**
 * src/flytlv.ts — minimal flytlv.app deals API client.
 *
 * Production knowledge reused from the read-only `reference/flytlv_app`
 * (`client.py` + `config.py`) — the owner's existing flytlv.app client:
 *
 *   - base URL from `FLYTLV_API_BASE` (default `https://flytlv.app`);
 *   - the deals endpoint is `/api/private/deals` (overridable via
 *     `FLYTLV_DEALS_PATH`); one-way flights at `/api/private/flights`
 *     (overridable via `FLYTLV_FLIGHTS_PATH`);
 *   - the `FLYTLV_API_KEY` Edge secret is **REQUIRED**: the server refuses to
 *     start without it (`config.require` at construction time), and it is sent
 *     as the `X-API-Key` header on **every** request (header name overridable
 *     via `FLYTLV_API_KEY_HEADER`, default `X-API-Key`);
 *   - **fail-closed** is the failure case only: a wrong or missing key
 *     (or a feed that has been switched off) returns `404`, which the client
 *     logs once at ERROR as `flytlv.feed_off` and surfaces as "unavailable" to
 *     the caller. A `404` is a configuration state, not a transient error, so
 *     it is not retried;
 *   - timeouts are short (a live phone caller cannot wait) and configurable
 *     via `FLYTLV_TIMEOUT_MS`, with a single retry on a timeout (a cold
 *     connection after a deploy can stall; verified live).
 *
 * Only what a single `search_deals` tool call needs lives here. A failure is
 * turned into a `FlytlvError` whose message is safe to surface verbatim as an
 * MCP `isError` result (never leaks the URL, the key or a traceback).
 */

import { config } from "./config.js";
import { error, warning } from "./log.js";

/** The flytlv deals API cannot be used right now. The message is
 * caller-friendly and safe to surface verbatim (never leaks the URL, key or
 * a traceback). */
export class FlytlvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlytlvError";
  }
}

/** Shape of a raw flytlv deals response. Loosely typed — the feed omits
 * fields on some deals (e.g. `is_direct`, `return_date`). */
export interface FlytlvPayload {
  currency?: string;
  deals?: unknown[];
  [k: string]: unknown;
}

/** Log the fail-closed 404 once per process instance. Edge scales to zero, so
 * "once" is best-effort within one instance; a fresh instance logs again. */
let offLogged = false;
function logFeedOffOnce(): void {
  if (offLogged) return;
  error("flytlv.feed_off", {
    status: 404,
    reason: "404 fail-closed: X-API-Key unset/rejected or feed switched off",
  });
  offLogged = true;
}

/** Stateless async client for one authenticated `GET /api/private/deals`. */
export class FlytlvClient {
  private readonly base: string;
  private readonly path: string;
  /** One-way flights endpoint (round trips use `path`). */
  private readonly flightsPath: string;
  private readonly apiKey: string;
  private readonly headerName: string;
  private readonly timeoutMs: number;

  constructor(private readonly fetchImpl: typeof fetch) {
    this.base = config.optional("FLYTLV_API_BASE", "https://flytlv.app").replace(/\/+$/, "");
    this.path = config.optional("FLYTLV_DEALS_PATH", "/api/private/deals");
    this.flightsPath = config.optional("FLYTLV_FLIGHTS_PATH", "/api/private/flights");
    this.apiKey = config.require("FLYTLV_API_KEY");
    this.headerName = config.optional("FLYTLV_API_KEY_HEADER", "X-API-Key");
    // Short by default: a phone caller is on the line. Configurable up.
    this.timeoutMs = config.integer("FLYTLV_TIMEOUT_MS", 3000);
  }

  /** One-way flights from Tel Aviv (`/api/private/flights`, items in `flights`). */
  async searchOneWay(params: Record<string, string>): Promise<FlytlvPayload> {
    const payload = await this.search(params, this.flightsPath);
    return { ...payload, deals: (payload.flights as unknown[] | undefined) ?? payload.deals ?? [] };
  }

  /**
   * GET with a timeout, retried once on timeout only: the first request after a
   * deploy or idle spell can stall on a cold connection (seen live: 3 s timeouts,
   * then 0.4 s). A GET is safe to repeat; other errors are not retried.
   */
  private async get(url: string, headers: Headers): Promise<Response> {
    try {
      return await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (!(e instanceof Error && e.name === "TimeoutError")) throw e;
      warning("flytlv.retry", { error: e.message });
      return await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    }
  }

  /**
   * Round-trip deals (`/api/private/deals`), or another feed path: one
   * authenticated GET, params forwarded as query params. Returns the parsed
   * payload or throws FlytlvError.
   */
  async search(params: Record<string, string>, path: string = this.path): Promise<FlytlvPayload> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = new Headers({ [this.headerName]: this.apiKey });

    let resp: Response;
    try {
      resp = await this.get(url.toString(), headers);
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        warning("flytlv.timeout", { error: e.message });
        throw new FlytlvError(
          "The deals service is taking too long to respond; please try again shortly.",
        );
      }
      error("flytlv.request_failed", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, e);
      throw new FlytlvError(
        "The deals service is temporarily unavailable; please try again.",
      );
    }

    if (resp.status === 404) {
      // Fail-closed feed: key unset/rejected or feed switched off.
      logFeedOffOnce();
      throw new FlytlvError(
        "The deals service is unavailable right now. Please try again later.",
      );
    }

    if (resp.status === 429) {
      warning("flytlv.rate_limited", { status: 429 });
      throw new FlytlvError(
        "The deals service is busy right now; please try again shortly.",
      );
    }

    if (resp.status >= 400) {
      error("flytlv.http_error", { status: resp.status });
      throw new FlytlvError(
        "The deals service is unavailable right now. Please try again later.",
      );
    }

    let payload: unknown;
    try {
      payload = await resp.json();
    } catch (e) {
      error("flytlv.bad_json", undefined, e);
      throw new FlytlvError("The deals service returned an unreadable response.");
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      error("flytlv.unexpected_shape", { type: payload === null ? "null" : typeof payload });
      throw new FlytlvError("The deals service returned an unexpected response.");
    }
    return payload as FlytlvPayload;
  }
}
