// Shared plumbing of the route-wide security tests (M8 T4). Lists every route handler and server
// action from the source tree (the same generator as scripts/ci/route-coverage.mjs, TST-122), so a
// new route or action is covered by the sweeps without editing them.
import type { Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain .mjs without types (CI tooling)
import * as rc from "../../scripts/ci/route-coverage.mjs";

const { generate, loadManifest, routeMethods, urlPathFor } = rc as unknown as {
  generate: (root: string) => Map<string, { kind: string }>;
  loadManifest: (root: string) => { routes: Record<string, unknown> };
  routeMethods: (src: string) => string[];
  urlPathFor: (relDir: string) => string;
};

export const ROOT = path.resolve(import.meta.dirname, "../..");

export type RouteSurface = { kind: "route"; id: string; method: string; url: string; file: string };
export type ActionSurface = { kind: "action"; id: string; name: string; file: string };
export type Surface = RouteSurface | ActionSurface;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const posix = (p: string) => p.split(path.sep).join("/");

/** Every `METHOD /url` route and `action file#name` in src/, straight from the source tree. */
export function surfaces(): Surface[] {
  const out: Surface[] = [];
  const appDir = path.join(ROOT, "src", "app");
  for (const file of walk(appDir).sort()) {
    if (!/^route\.(ts|js)$/.test(path.basename(file))) continue;
    const url = urlPathFor(posix(path.relative(appDir, path.dirname(file)))) as string;
    for (const method of routeMethods(fs.readFileSync(file, "utf8")) as string[]) {
      out.push({
        kind: "route",
        id: `${method} ${url}`,
        method,
        url,
        file: posix(path.relative(ROOT, file)),
      });
    }
  }
  for (const id of (generate(ROOT) as Map<string, { kind: string }>).keys()) {
    if (!id.startsWith("action ")) continue;
    const [file, name] = id.slice("action ".length).split("#");
    out.push({ kind: "action", id, name, file });
  }
  return out;
}

export const routesOf = (all: Surface[]): RouteSurface[] =>
  all.flatMap((s) => (s.kind === "route" ? [s] : []));
export const actionsOf = (all: Surface[]): ActionSurface[] =>
  all.flatMap((s) => (s.kind === "action" ? [s] : []));

/** Ids of the merged route manifest (manifest.json + fragments): must equal the source list. */
export function manifestIds(): string[] {
  return Object.keys((loadManifest(ROOT) as { routes: Record<string, unknown> }).routes);
}

/** Replaces `[param]` / `[...param]` segments with a plausible value. */
export const concreteUrl = (url: string): string =>
  url.replace(/\[\.\.\.[^\]]+\]/g, "x").replace(/\[[^\]]+\]/g, "sample-1");

export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Routes that authenticate themselves (HMAC / CRON_SECRET / test-identity), exempt from the gate. */
export const isMachineUrl = (url: string): boolean =>
  url.startsWith("/api/internal/") ||
  url.startsWith("/api/cron/") ||
  url === "/api/test-identity/login";

/** Auth.js owns /api/auth/*; its own CSRF and origin checks apply. */
export const isAuthJsUrl = (url: string): boolean => url.startsWith("/api/auth/");

/** Every table of a database as JSON, in rowid order: equal before and after = nothing changed. */
export async function snapshot(db: Client, skip: readonly string[] = []): Promise<string> {
  const tables = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const dump: Record<string, unknown> = {};
  for (const t of tables.rows) {
    const name = String(t.name);
    if (skip.includes(name)) continue;
    const rows = await db.execute(`SELECT * FROM "${name}"`);
    dump[name] = rows.rows.map((r) => JSON.stringify(Object.values(r))).sort();
  }
  return JSON.stringify(dump);
}
