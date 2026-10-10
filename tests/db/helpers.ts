import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const MIGRATIONS = (name: "main" | "auth") => path.join(ROOT, "db", "migrations", name);

const dirs: string[] = [];

export function tempDbUrl(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-db-"));
  dirs.push(dir);
  return pathToFileURL(path.join(dir, "t.db")).href;
}

const clients: Client[] = [];

export function track(c: Client): Client {
  clients.push(c);
  return c;
}

export function cleanupTempDbs(): void {
  for (const c of clients.splice(0)) c.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may keep a lock briefly; the OS temp folder is cleaned later.
    }
  }
}

export async function freshDb(name: "main" | "auth"): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl() }));
  await migrateUp(db, await loadMigrations(MIGRATIONS(name)));
  return db;
}

export async function schemaOf(db: Client): Promise<string[]> {
  const r = await db.execute(
    "SELECT type || ':' || name || ':' || COALESCE(sql,'') AS s FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY type, name",
  );
  return r.rows.map((x) => String(x.s));
}
