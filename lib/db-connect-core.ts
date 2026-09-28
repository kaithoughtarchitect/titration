// Titration MCP — DB connection SSL policy (pure core).
//
// A hardcoded `ssl: "require"` on every `postgres(...)` call is correct for a
// managed remote host (Neon), but it refuses to even connect to a
// local/self-hosted Postgres (docker-compose, bare `localhost`, or a container
// reached via `host.docker.internal`) that never terminates TLS. This module
// is the ONE rule every `postgres(...)` call in this repo goes through instead.
//
// Pure: no I/O, no Date.now()/Math.random() — offline-tested by
// db-connect-core.test.ts. `env` is passed in (not read from `process.env`
// directly) so the decision stays testable without a process environment.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

export type SslMode = "require" | false;

/** Best-effort hostname extraction; an unparseable URL falls through to "" (never local). */
function hostFromUrl(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  // WHATWG URL brackets an IPv6 hostname (e.g. "[::1]"); strip the brackets so it
  // compares equal to the bare "::1" entry in LOCAL_HOSTS.
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Decide the postgres-js `ssl` option for `url`.
 *
 * `TITRATION_DB_SSL=require` or `=disable` is an explicit user override and
 * wins regardless of the host (a local Postgres terminated behind TLS, or a
 * "trusted" remote host the user has decided not to encrypt). Otherwise: a
 * local/known-unencrypted host (`localhost`, `127.0.0.1`, `::1`,
 * `host.docker.internal` — with or without a port) gets `ssl: false`; every
 * other host defaults to `ssl: "require"`.
 */
export function sslModeFor(url: string, env: Record<string, string | undefined>): SslMode {
  const override = env.TITRATION_DB_SSL?.trim().toLowerCase();
  if (override === "require") return "require";
  if (override === "disable") return false;

  return LOCAL_HOSTS.has(hostFromUrl(url)) ? false : "require";
}

/** The postgres-js connection options object every `postgres(url, ...)` call in this repo spreads in. */
export function postgresOptions(
  url: string,
  env: Record<string, string | undefined>,
): { ssl: SslMode } {
  return { ssl: sslModeFor(url, env) };
}
