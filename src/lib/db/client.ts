// Database clients from environment (D-020, ROL-101a). Errors never include env values.
import { createClient, type Client } from "@libsql/client";

const isLocal = (u: string) => u.startsWith("file:") || u === ":memory:";

function make(urlVar: string, tokenVar: string): Client {
  const url = process.env[urlVar];
  const authToken = process.env[tokenVar];
  if (!url || (!authToken && !isLocal(url))) throw new Error("database not configured");
  return createClient({ url, authToken: authToken || undefined });
}

export function mainDb(): Client {
  return make("TURSO_MAIN_URL", "TURSO_MAIN_TOKEN");
}

// Only the Vercel app holds the auth-DB token (ROL-101a); never call this from workers/Actions.
export function authDb(): Client {
  return make("TURSO_AUTH_URL", "TURSO_AUTH_TOKEN");
}
