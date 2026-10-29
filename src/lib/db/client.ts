// Database clients from environment (D-020, ROL-101a). Errors never include env values.
// D-204: one client per database and process, reused by every request. A new client per call opened
// a new connection for each page and threw away the loaders' memo (design 2.9) with it. The libsql
// client keeps no per-request state (each transaction has its own stream), so sharing it is safe;
// callers never close it. A closed client (a test, a dropped connection) is replaced.
import { createClient, type Client } from "@libsql/client";

const isLocal = (u: string) => u.startsWith("file:") || u === ":memory:";
const shared = new Map<string, Client>();

function make(urlVar: string, tokenVar: string): Client {
  const url = process.env[urlVar];
  const authToken = process.env[tokenVar];
  if (!url || (!authToken && !isLocal(url))) throw new Error("database not configured");
  const key = `${url}\n${authToken ?? ""}`;
  const hit = shared.get(key);
  if (hit && !hit.closed) return hit;
  const client = createClient({ url, authToken: authToken || undefined });
  shared.set(key, client);
  return client;
}

export function mainDb(): Client {
  return make("TURSO_MAIN_URL", "TURSO_MAIN_TOKEN");
}

// Only the Vercel app holds the auth-DB token (ROL-101a); never call this from workers/Actions.
export function authDb(): Client {
  return make("TURSO_AUTH_URL", "TURSO_AUTH_TOKEN");
}
