// Environment of the Worker runners inside the clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §4).
// The runners are the Worker's own code and read `TURSO_MAIN_URL` (libsql or https only) and `APP_BASE_URL`
// (https only). The self-hosted containers talk plain http inside the Docker network, so for those two
// values the runners get an https stand-in with the same host, and the fetch shim (shim.ts) maps the
// stand-in origin back to the real one. A value that is already https/libsql is left alone (for example
// the side-by-side week pointing at Turso).
import type { AsxEnv } from "../worker/src/asx/slots";
import type { UniverseEnv } from "../worker/src/asx/universe";
import type { ClockEnv } from "../worker/src/clock";
import type { RouteEnv } from "../worker/src/routes";
import type { RunNowEnv } from "../worker/src/runNow";

export type TickEnv = ClockEnv & RouteEnv & RunNowEnv & AsxEnv & UniverseEnv;
export type RawEnv = Readonly<Record<string, string | undefined>>;

/** Sent as the dispatch token when none is set: the shim answers every dispatch except `passthrough`. */
export const LOCAL_TOKEN_PLACEHOLDER = "local-clock-no-github-token";

const HTTP_RE = /^http:\/\/([^/\s]+)\/?$/;

export type BuiltEnv = {
  env: TickEnv;
  /** Stand-in https origin -> real http origin, for the fetch shim. */
  origins: Record<string, string>;
  /** Plain words about configuration the Owner should know of (no values). */
  warnings: string[];
};

export function buildClockEnv(src: RawEnv): BuiltEnv {
  const origins: Record<string, string> = {};
  const warnings: string[] = [];
  const env: Record<string, string | undefined> = { ...src };
  const db = HTTP_RE.exec((src.TURSO_MAIN_URL ?? "").trim());
  if (db) {
    env.TURSO_MAIN_URL = `libsql://${db[1]}`;
    origins[`https://${db[1]}`] = `http://${db[1]}`;
  }
  const app = HTTP_RE.exec((src.APP_BASE_URL ?? "").trim());
  if (app) {
    env.APP_BASE_URL = `https://${app[1]}`;
    origins[`https://${app[1]}`] = `http://${app[1]}`;
  }
  if (!env.PRAXIS_ENV) env.PRAXIS_ENV = "production";
  if ((env.GITHUB_DISPATCH_TOKEN ?? "").trim() === "") {
    env.GITHUB_DISPATCH_TOKEN = LOCAL_TOKEN_PLACEHOLDER;
    warnings.push("GITHUB_DISPATCH_TOKEN is empty: the replay dispatch to GitHub will be refused");
  }
  for (const n of ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN", "APP_BASE_URL", "WORKER_HMAC_SECRET"]) {
    if ((src[n] ?? "").trim() === "") warnings.push(`${n} is not set`);
  }
  return { env: env as unknown as TickEnv, origins, warnings };
}
