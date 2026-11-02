// @vitest-environment node
// M16 fix S1 (UXN-298): the side panel's extra data from the live loader: config values (known keys
// only), the last 5 runs per job, and the licence row of a source. Synthetic ZZ data; read-only.
import type { Client } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { loadBlueprintStatus, RUNS_SHOWN } from "@/lib/ui/loaders/blueprint";

afterAll(cleanupTempDbs);

const NOW = new Date("2026-10-20T03:00:00.000Z");
const KEY = Object.keys(CONFIG_KEYS)[0];
const model = {
  elements: [
    { id: "workflow:ingest-batch1", type: "workflow", configKeys: [KEY, "zz.unknown_key"] },
    { id: "workflow:zz-never-ran", type: "workflow" },
    { id: "source:abs", type: "source" },
    { id: "source:zz_unlisted", type: "source" },
    { id: "service:zz-thing", type: "service", configKeys: [KEY] },
  ],
};

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  for (let i = 0; i < 7; i++) {
    const at = `2026-10-1${i}T00:00:00.000Z`;
    await db.execute({
      sql: `INSERT INTO run_record (job, concurrency_key, started_at, ended_at, status, items_processed)
            VALUES ('ingest-batch1', ?, ?, ?, ?, ?)`,
      args: [`k${i}`, at, at, i === 6 ? "failed" : "success", i],
    });
  }
});

describe("Blueprint panel data", () => {
  it("returns the last 5 runs, newest first, with no error text", async () => {
    const r = await loadBlueprintStatus({ mainDb: db, now: NOW }, model);
    const runs = r.runs["workflow:ingest-batch1"];
    expect(runs).toHaveLength(RUNS_SHOWN);
    expect(runs.map((x) => x.items)).toEqual([6, 5, 4, 3, 2]);
    expect(runs[0].status).toBe("failed");
    expect(Object.keys(runs[0]).sort()).toEqual(["at", "durationMs", "items", "status"]);
    expect(r.runs["workflow:zz-never-ran"]).toEqual([]);
    expect(r.runs["service:zz-thing"]).toBeUndefined();
  });

  it("returns the licence row for a registered source only", async () => {
    const r = await loadBlueprintStatus({ mainDb: db, now: NOW }, model);
    const reg = await db.execute("SELECT risk, status FROM source_register WHERE source='abs'");
    const l = r.licences["source:abs"];
    expect(l.risk).toBe(String(reg.rows[0].risk));
    expect(l.status).toBe(String(reg.rows[0].status));
    expect(typeof l.summarisationPermitted).toBe("boolean");
    expect(r.licences["source:zz_unlisted"]).toBeUndefined();
  });

  it("returns current values for the listed known config keys only", async () => {
    const r = await loadBlueprintStatus({ mainDb: db, now: NOW }, model);
    const c = r.config["workflow:ingest-batch1"];
    expect(c.map((x) => x.key)).toEqual([KEY]);
    expect(c[0].value).toBe(JSON.stringify(CONFIG_KEYS[KEY as keyof typeof CONFIG_KEYS].default));
    expect(r.config["service:zz-thing"]).toHaveLength(1);
    expect(r.config["source:abs"]).toBeUndefined();
  });

  it("writes nothing", async () => {
    const before = await db.execute("SELECT COUNT(*) AS n FROM run_record");
    await loadBlueprintStatus({ mainDb: db, now: NOW }, model);
    const after = await db.execute("SELECT COUNT(*) AS n FROM run_record");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
