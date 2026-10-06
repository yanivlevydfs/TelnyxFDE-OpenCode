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

/** Emit one JSON log line to the console if it passes the level gate. */
function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
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
