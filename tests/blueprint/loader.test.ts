// @vitest-environment node
// M16 WP4 (ARC-002, D-372): the Blueprint live status loader. Synthetic ZZ fixtures on a migrated
// test DB: states map, an element with no source is unknown, nothing is written, nothing is fetched.
import type { Client } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { loadBlueprintStatus, SIMULATED_LINE } from "@/lib/ui/loaders/blueprint";

afterAll(cleanupTempDbs);

const NOW = new Date("2026-10-20T03:00:00.000Z");
const model = {
  elements: [
    { id: "workflow:ingest-batch1", type: "workflow" },
    { id: "workflow:arena-close", type: "workflow" },
    { id: "workflow:zz-never-ran", type: "workflow" },
    { id: "workflow:backup", type: "workflow" },
    { id: "slot:arena-signals", type: "slot", attrs: { enabled: true } },
    { id: "slot:asx-poll", type: "slot", attrs: { enabled: false } },
    { id: "source:abs", type: "source" },
    { id: "source:yahoo_eod", type: "source" },
    { id: "source:rba", type: "source" },
    { id: "source:zz_unlisted", type: "source" },
    { id: "table:main.instrument", type: "table" },
    { id: "group:cortex-states", type: "group" },
    { id: "group:cortex-angles", type: "group" },
    { id: "group:lane-a", type: "group" },
    { id: "service:zz-thing", type: "service" },
  ],
};

let db: Client;
const run = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args });
const job = (j: string, status: string, key: string, at: string) =>
  run(
    `INSERT INTO run_record (job, concurrency_key, started_at, ended_at, status) VALUES (?,?,?,?,?)`,
    [j, key, at, at, status],
  );

async function rowCounts(): Promise<string> {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: string[] = [];
  for (const r of t.rows) {
    const c = await db.execute(`SELECT COUNT(*) AS n FROM "${String(r.name)}"`);
    out.push(`${String(r.name)}=${String(c.rows[0].n)}`);
  }
  return out.join(",");
}

beforeEach(async () => {
  db = await freshDb("main");
  await job("ingest-batch1", "success", "ib1", "2026-10-20T00:00:00.000Z");
  await job("arena-close", "failed", "ac1", "2026-10-19T08:00:00.000Z");
  await job("nightly-backup", "degraded", "nb1", "2026-10-19T12:00:00.000Z");
  await job("arena-signals", "success", "as1", "2026-10-19T08:10:00.000Z");
  await run(`UPDATE source_status SET mode='off' WHERE source='abs'`);
  await run(`UPDATE source_status SET mode='tripped' WHERE source='rba'`);
  await run(
    `INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by)
     VALUES ('AU','F1','2026-10-01','allowed','{}','import'),('AU','F2','2026-10-01','suspended','{}','evaluator')`,
  );
  await run(
    `INSERT INTO angle_passport (market, angle_id, version, domain, cluster, orientation, kind, inputs_json,
       history_fields_json, status, horizon_sessions, evidence_json, measured_json, frozen_at)
     VALUES ('AU','zz_a',1,1,'momentum',1,'score','[]','{}','active',10,'{}',NULL,'2026-10-01T00:00:00Z'),
            ('AU','zz_b',1,1,'momentum',1,'score','[]','{}','candidate',10,'{}',NULL,'2026-10-01T00:00:00Z')`,
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("loadBlueprintStatus", () => {
  it("maps run, slot, source and group states", async () => {
    const s = (await loadBlueprintStatus({ mainDb: db, now: NOW }, model)).statuses;
    expect(s["workflow:ingest-batch1"].state).toBe("ok");
    expect(s["workflow:ingest-batch1"].lastRunAt).toBe("2026-10-20T00:00:00.000Z");
    expect(s["workflow:arena-close"].state).toBe("fail");
    expect(s["workflow:backup"].state).toBe("warn");
    expect(s["slot:arena-signals"].state).toBe("ok");
    expect(s["slot:asx-poll"].state).toBe("off");
    expect(s["source:abs"].state).toBe("off");
    expect(s["source:rba"].state).toBe("fail");
    expect(s["source:yahoo_eod"].state).toBe("off"); // pending the Owner's acceptance
    expect(s["group:cortex-states"].state).toBe("warn");
    expect(s["group:cortex-states"].detail).toContain("1 allowed, 1 suspended");
    expect(s["group:cortex-angles"].state).toBe("ok");
    expect(s["group:cortex-angles"].detail).toContain("2 passports: 1 active");
  });

  it("gives an element with no source the unknown state", async () => {
    const s = (await loadBlueprintStatus({ mainDb: db, now: NOW }, model)).statuses;
    for (const id of [
      "workflow:zz-never-ran",
      "source:zz_unlisted",
      "table:main.instrument",
      "group:lane-a",
      "service:zz-thing",
    ]) {
      expect(s[id].state).toBe("unknown");
    }
    expect(Object.keys(s)).toHaveLength(model.elements.length);
  });

  it("carries the Simulated and freshness lines in Melbourne time", async () => {
    const r = await loadBlueprintStatus({ mainDb: db, now: NOW }, model);
    expect(r.simulatedLine).toBe(SIMULATED_LINE);
    expect(r.freshnessLine).toMatch(/^Status as of .*AEDT \(UTC\+11\)$/);
    expect(JSON.stringify(r)).not.toMatch(/\bUTC\b(?!\+)/);
  });

  it("writes nothing and makes no outside request", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch is not allowed");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const before = await rowCounts();
    const changes = Number((await run("SELECT total_changes() AS n")).rows[0].n);
    await loadBlueprintStatus({ mainDb: db, now: NOW }, model);
    expect(await rowCounts()).toBe(before);
    expect(Number((await run("SELECT total_changes() AS n")).rows[0].n)).toBe(changes);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves statuses unknown instead of throwing when the database is unreadable", async () => {
    const bad = { execute: () => Promise.reject(new Error("down")) } as unknown as Client;
    const r = await loadBlueprintStatus({ mainDb: bad, now: NOW }, model);
    expect(Object.values(r.statuses).every((x) => x.state === "unknown" || x.state === "off")).toBe(
      true,
    );
  });
});
