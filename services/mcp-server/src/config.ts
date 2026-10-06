/**
 * src/config.ts — environment configuration (lazy, read at call time).
 *
 * Mirrors `shared/common.py`'s config helpers: nothing is bound at import time
 * so tests can set `process.env` before invoking the server. Only the
 * non-secret defaults live in `func.toml`'s `[env_vars]`; secrets arrive as
 * runtime env vars from Edge secrets.
 *
 * Run tests:  cd services/mcp-server && npm test
 */

/** Raised when a required env var is missing or fails to parse. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Read an env var, trimmed; `undefined` when unset. */
function read(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v.trim();
}

/**
 * Environment configuration. Each helper reads `process.env` at call time
 * (never at module load) so the order of "set env" vs "import" does not
 * matter for tests.
 */
export const config = {
  /** Return a required, trimmed env var. Raise ConfigError if unset. */
  require(name: string): string {
    const v = read(name);
    if (v === undefined) throw new ConfigError(`missing required env var: ${name}`);
    return v;
  },
  /** Return a trimmed env var, or `def` if unset (empty string stays ""). */
  optional(name: string, def: string): string {
    const v = read(name);
    return v === undefined ? def : v;
  },
  /** Parse an int env var; `def` if unset; ConfigError if unparseable. */
  integer(name: string, def: number): number {
    const v = read(name);
    if (v === undefined) return def;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) {
      throw new ConfigError(`${name}=${JSON.stringify(v)} is not an integer`);
    }
    return n;
  },
  /** Parse a boolean flag (yes/on/true/1 → true); `def` if unset. */
  flag(name: string, def = false): boolean {
    const v = read(name);
    if (v === undefined) return def;
    return ["yes", "on", "true", "1"].includes(v.toLowerCase());
  },
};
