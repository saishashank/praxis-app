// @vitest-environment node
// AT-75 (series clause; M23 S1, D-1632, D-1633): the stored sector series of a fixture market matches hand-computed
// values, only `equal` rows exist, the step writes only sector_index, forward only, and nothing for a market that is off.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runResearchNight } from "@/lib/research/night";
import { sectorIndexStep } from "@/lib/research/steps/sectorIndex";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { EXPECTED, SESSIONS, enableZz, plantZz } from "../../research/sectorFixture";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
afterEach(cleanupTempDbs);

const night = (db: Client, d: string, replay = false) =>
  runResearchNight(db, { market: "ZZ", d, now: `${d}T10:00:00Z`, replay }, [sectorIndexStep]);

/** A hash per table of every row, except the tables named in `skip`. */
async function dump(db: Client, skip: ReadonlySet<string>): Promise<Record<string, string>> {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, string> = {};
  for (const n of t.rows.map((r) => String(r.name))) {
    if (skip.has(n)) continue;
    const rs = await db.execute(`SELECT * FROM ${n}`);
    const lines = rs.rows.map((r) => JSON.stringify(Object.values(r).map(String))).sort();
    out[n] = createHash("sha256").update(lines.join("\n")).digest("hex");
  }
  return out;
}

describe("AT-75 (series): the sector index of a fixture market", () => {
  it("five nights through the research seam give the hand-computed series", async () => {
    const db = await freshDb("main");
    await enableZz(db);
    await plantZz(db);
    for (const d of SESSIONS) {
      const r = await night(db, d);
      expect(r.status).toBe("ran");
      expect(r.failed).toEqual([]);
    }
    const r = await db.execute(
      "SELECT d, group_code, weighting, ret_ppm, level_ppm, n_members FROM sector_index ORDER BY d, group_code",
    );
    expect(
      r.rows.map((x) => ({
        d: String(x.d),
        group: String(x.group_code),
        retPpm: Number(x.ret_ppm),
        levelPpm: Number(x.level_ppm),
        n: Number(x.n_members),
      })),
    ).toEqual(EXPECTED);
    // no value-weighted row exists (D-1632); the first session is the base and has no row
    expect(r.rows.some((x) => x.weighting !== "equal")).toBe(false);
    expect(r.rows.some((x) => x.d === SESSIONS[0])).toBe(false);
  });

  it("writes only sector_index: every other table is unchanged by a night", async () => {
    const db = await freshDb("main");
    await enableZz(db);
    await plantZz(db);
    const skip = new Set(["sector_index"]);
    const before = await dump(db, skip);
    await night(db, SESSIONS[1]);
    await night(db, SESSIONS[2]);
    expect(await dump(db, skip)).toEqual(before);
    expect(Number((await db.execute("SELECT COUNT(*) n FROM sector_index")).rows[0]!.n)).toBe(6);
  });

  it("is idempotent and forward only: a repeated or earlier night writes nothing", async () => {
    const db = await freshDb("main");
    await enableZz(db);
    await plantZz(db);
    await night(db, SESSIONS[2]);
    const n1 = Number((await db.execute("SELECT COUNT(*) n FROM sector_index")).rows[0]!.n);
    expect(n1).toBe(3);
    await night(db, SESSIONS[2]); // same night again
    await night(db, SESSIONS[1]); // an earlier night is not back-filled
    expect(Number((await db.execute("SELECT COUNT(*) n FROM sector_index")).rows[0]!.n)).toBe(3);
    // the first stored level starts from the base, the next chains from it
    await night(db, SESSIONS[3]);
    const lv = await db.execute({
      sql: "SELECT level_ppm FROM sector_index WHERE d = ? AND group_code = 'GA'",
      args: [SESSIONS[3]],
    });
    expect(Number(lv.rows[0]!.level_ppm)).toBe(1100000); // 1,000,000 x 1.0 (session 2 return 0) x 1.1
  });

  it("writes nothing on a replay, for a market that is not enabled, or without bars", async () => {
    const db = await freshDb("main");
    await enableZz(db);
    await plantZz(db);
    expect((await night(db, SESSIONS[1], true)).status).toBe("skipped_replay");
    const off = await runResearchNight(
      db,
      { market: "IN", d: SESSIONS[1], now: `${SESSIONS[1]}T10:00:00Z` },
      [sectorIndexStep],
    );
    expect(off.status).toBe("skipped_market");
    await night(db, "2030-02-01"); // a date with no bars
    expect(Number((await db.execute("SELECT COUNT(*) n FROM sector_index")).rows[0]!.n)).toBe(0);
  });

  it("the table is append-only (an update or a delete is refused)", async () => {
    const db = await freshDb("main");
    await enableZz(db);
    await plantZz(db);
    await night(db, SESSIONS[1]);
    await expect(db.execute("UPDATE sector_index SET ret_ppm = 1")).rejects.toThrow();
    await expect(db.execute("DELETE FROM sector_index")).rejects.toThrow();
  });
});
