/**
 * src/log.ts — structured JSON logging + per-request trace id.
 *
 * One JSON object per line: `{ts, level, service, event, trace_id, ...fields,
 * exception?}`. The `trace_id` is the current Telnyx conversation id (set by
 * each tool callback) and is also sent on the outbound actor request header
 * (`TRACE_HEADER`, default `x-trace-id`). Matches the Python services' log
 * shape so `telnyx-edge logs --json | jq` works across services.
 *
 * `LOG_LEVEL` gates output (default `INFO`); ERROR lines include the caught
 * error's stack as `exception` when passed.
 */

import { config } from "./config.js";

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const LEVELS: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

/** One LOG_LEVEL setting per process (Edge pods scale to zero between calls). */
let logLevel: Level = "INFO";
{
  const envLevel = config.optional("LOG_LEVEL", "INFO").toUpperCase();
  if (envLevel in LEVELS) logLevel = envLevel as Level;
}

/** Current trace id (the conversation id of the in-flight request). */
let traceId = "";

/** Set the current trace id; empty when none/blank. */
export function setTraceId(id?: string): void {
  traceId = id && id.length > 0 ? id : "";
}

/** Read the current trace id (used for the outbound actor header). */
export function getTraceId(): string {
  return traceId;
}

/** Timestamp in the logging timezone (LOG_TIMEZONE, default Asia/Jerusalem) as
 * ISO 8601 with its UTC offset, e.g. "2026-10-07T00:45:12.345+03:00". */
export function localIso(d: Date = new Date()): string {
  const tz = process.env.LOG_TIMEZONE ?? "Asia/Jerusalem";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const v = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  const wall = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  const offMin = Math.round((wall - (d.getTime() - d.getMilliseconds())) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const date = `${v("year")}-${pad(v("month"))}-${pad(v("day"))}`;
  const time = `${pad(v("hour"))}:${pad(v("minute"))}:${pad(v("second"))}.${pad(d.getMilliseconds(), 3)}`;
  return `${date}T${time}${sign}${pad(Math.trunc(offMin / 60))}:${pad(offMin % 60)}`;
}

/** Emit one JSON log line to the console if it passes the level gate. */
function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const line = JSON.stringify({
    ts: localIso(),
    level,
    service: "fde-mcp",
    event,
    trace_id: traceId,
    ...fields,
  });
  if (level === "ERROR") console.error(line);
  else if (level === "WARNING") console.warn(line);
  else console.log(line);
}

/** DEBUG line. */
export function debug(event: string, fields: Record<string, unknown> = {}): void {
  log("DEBUG", event, fields);
}

/** INFO line. */
export function info(event: string, fields: Record<string, unknown> = {}): void {
  log("INFO", event, fields);
}

/** WARNING line. */
export function warning(event: string, fields: Record<string, unknown> = {}): void {
  log("WARNING", event, fields);
}

/**
 * ERROR line. Pass the caught error to append its stack as `exception`.
 * Mirrors Python's `error(event, exc_info=True, **fields)`.
 */
export function error(
  event: string,
  fields: Record<string, unknown> = {},
  err?: unknown,
): void {
  const extra: Record<string, unknown> = { ...fields };
  if (err instanceof Error) extra.exception = err.stack ?? err.message;
  else if (err !== undefined) extra.exception = String(err);
  log("ERROR", event, extra);
}
