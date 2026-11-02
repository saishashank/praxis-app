// Shared ZZ world of the WP6 tests (review service, loaders, pages). The main database holds the ZZ expert seed
// imported through the real importer; the auth database holds one owner, one editor, one viewer. Screening rows
// are inserted directly (the run itself belongs to WP4). No real name, no real host (SEC-110, D-521).
import type { Client } from "@libsql/client";
import { run } from "../../scripts/experts/import.mjs";
import { addUser } from "../auth/helpers";
import { freshDb } from "../db/helpers";
import { type SeedFiles, writeSeed, zzSeedFiles } from "./zzSeed";

export type World = {
  main: Client;
  auth: Client;
  owner: number;
  editor: number;
  viewer: number;
};

export async function importSeed(main: Client, mod?: (f: SeedFiles) => void): Promise<void> {
  const f = zzSeedFiles();
  mod?.(f);
  const { dir, cleanup } = writeSeed(f);
  try {
    const code = await run(
      [dir],
      { TURSO_MAIN_URL: "file:zz", TURSO_MAIN_TOKEN: "tok-zz" },
      {
        out: () => undefined,
        openDb: () => ({
          execute: (s: never) => main.execute(s),
          batch: (s: never, m: never) => main.batch(s, m),
          close: () => undefined,
        }),
      },
    );
    if (code !== 0) throw new Error("seed import failed");
  } finally {
    cleanup();
  }
}

export async function usersIn(auth: Client): Promise<Omit<World, "main" | "auth">> {
  return {
    owner: await addUser(auth, { email: "owner@example.test", role: "owner" }),
    editor: await addUser(auth, { email: "editor@example.test", role: "editor" }),
    viewer: await addUser(auth, { email: "viewer@example.test", role: "viewer" }),
  };
}

export async function zzWorld(mod?: (f: SeedFiles) => void): Promise<World> {
  const main = await freshDb("main");
  const auth = await freshDb("auth");
  await importSeed(main, mod);
  return { main, auth, ...(await usersIn(auth)) };
}

const SHA = "b".repeat(64);
export async function addRun(
  db: Client,
  d: string,
  results: { cluster: string; survived: boolean; rank?: number | null }[],
): Promise<string> {
  const runId = `expscreen:AU:${d}`;
  await db.execute({
    sql: `INSERT INTO screening_run (run_id, market, d, q, considered, eligible, screened, survivors, splits_json, created_at)
          VALUES (?, 'AU', ?, 0.1, ?, ?, ?, ?, '{}', ?)`,
    args: [
      runId,
      d,
      results.length,
      results.length,
      results.length,
      results.filter((r) => r.survived).length,
      `${d}T00:00:00.000Z`,
    ],
  });
  for (const r of results) {
    await db.execute({
      sql: `INSERT INTO screening_result (run_id, cluster_id, family, params_sha, rows, blocks, mean_net_ppm,
              mean_excess_ppm, lower90_ppm, p, adjusted_p, bh_rejected, sign_agrees, survived, rank, grade)
            VALUES (?, ?, 'F1', ?, 40, 8, 12000, 15000, 4000, 0.01, 0.02, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        r.cluster,
        SHA,
        r.survived ? 1 : 0,
        r.survived ? 1 : 0,
        r.survived ? 1 : 0,
        r.survived ? (r.rank ?? 1) : null,
        r.survived ? "L1" : "L0",
      ],
    });
  }
  return runId;
}
