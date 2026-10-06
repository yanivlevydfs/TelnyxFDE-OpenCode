/**
 * log.ts — one structured JSON logger for the actor and its HTTP facade.
 *
 * Every line: ts (LOG_TIMEZONE, default Asia/Jerusalem, ISO 8601 with offset),
 * level, service, event, trace_id (from the caller's x-trace-id, per request)
 * and fields. Caller ids (`entity`) are masked to the last 4 digits.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";
const LEVELS: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

const envLevel = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
const logLevel: Level = envLevel in LEVELS ? (envLevel as Level) : "INFO";

/** Trace id of the request being handled; one context per request, so
 * overlapping requests in one instance never mix ids. */
export const traceContext = new AsyncLocalStorage<{ id: string }>();

/** Timestamp in LOG_TIMEZONE (default Asia/Jerusalem) as ISO 8601 with its
 * UTC offset, e.g. "2026-10-07T00:45:12.345+03:00". */
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

/** Emit one JSON log line if it passes the LOG_LEVEL gate. */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const entity = typeof fields.entity === "string" && fields.entity ? `***${fields.entity.slice(-4)}` : undefined;
  const line = JSON.stringify({
    ts: localIso(),
    level,
    service: "session-actor",
    event,
    trace_id: traceContext.getStore()?.id ?? "",
    ...fields,
    ...(entity ? { entity } : {}),
  });
  if (level === "ERROR") console.error(line);
  else if (level === "WARNING") console.warn(line);
  else console.log(line);
}
