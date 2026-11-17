// @vitest-environment node
// M22 E5 (DAT-248, D-1440; BLD-051, CXA-015): the one look. Below the sample nothing is written; at the sample exactly one
// holdout_look row; a second evaluation is refused twice over and computes nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import {
  ALT_LINEAGE,
  FORWARD_SESSIONS,
  HYPOTHESIS_TEXT,
  MIN_DIFFERING,
  PREREG_SHA,
  altLookTaken,
  evaluateAlt,
} from "@/lib/regime/alt/evaluate";
import { cleanupTempDbs } from "../../db/helpers";
import { NOW, world } from "./harness";

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
afterEach(cleanupTempDbs);

const START = "2029-01-01";
const day = (i: number): string => addDays(START, i);

/**
 * n+21 benchmark closes and n readings; the first `diff` readings differ. The index falls through session 59 and rises after
 * (`early = "falls"`), or the opposite (`"rises"`), so the 20-session returns of the differing sessions are below (or above)
 * those of the others.
 */
async function seed(db: Client, n: number, diff: number, early: "falls" | "rises"): Promise<void> {
  const closes: number[] = [];
  let c = 10_000_000_000;
  for (let i = 0; i < n + FORWARD_SESSIONS + 1; i += 1) {
    const wiggle = (((i * 7919) % 13) - 6) * 1_000_000;
    const down = early === "falls" ? i < 60 : i >= 60;
    c += wiggle + (down ? -50_000_000 : 50_000_000);
    closes.push(c);
  }
  for (let i = 0; i < closes.length; i += 1) {
    await db.execute({
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES ('AU', 'AXJO', ?, ?, ?, ?, ?, 'zz', ?, ?)`,
      args: [day(i), closes[i]!, closes[i]!, closes[i]!, closes[i]!, NOW, NOW],
    });
  }
  for (let i = 0; i < n; i += 1) {
    await db.execute({
      sql: `INSERT INTO regime_alt_reading (market, d, base_state, alt_state, inputs_status, inputs_json, created_at)
            VALUES ('AU', ?, 'NEUTRAL', ?, 'ok', '{}', ?)`,
      args: [day(i), i < diff ? "RISK-OFF" : "NEUTRAL", NOW],
    });
  }
}

const looks = async (db: Client): Promise<number> =>
  Number((await db.execute("SELECT COUNT(*) n FROM holdout_look")).rows[0]!.n);

describe("evaluateAlt", () => {
  it("the hypothesis text and fingerprint are fixed", () => {
    expect(HYPOTHESIS_TEXT).toMatch(/one look; never re-looked/i);
    expect(PREREG_SHA).toMatch(/^[0-9a-f]{16}$/);
    expect(MIN_DIFFERING).toBe(30);
    expect(FORWARD_SESSIONS).toBe(20);
  });

  it("below the sample writes nothing and takes no look", async () => {
    const db = await world();
    await seed(db, 100, 20, "falls");
    const r = await evaluateAlt(db, { market: "AU", now: () => NOW });
    expect(r).toEqual({ status: "below_sample", differing: 20, sessions: 100 });
    expect(await looks(db)).toBe(0);
    expect(await altLookTaken(db, "AU")).toBe(false);
  });

  it("at the sample takes exactly one look, and a second evaluation is refused twice", async () => {
    const db = await world();
    await seed(db, 200, 40, "falls");
    const first = await evaluateAlt(db, { market: "AU", now: () => NOW });
    expect(first.status).toBe("looked");
    if (first.status !== "looked") return;
    expect(first.differing).toBe(40);
    expect(["pass", "fail"]).toContain(first.verdict);
    const row = (await db.execute("SELECT lineage, market, prereg_sha, verdict FROM holdout_look"))
      .rows[0]!;
    expect(row).toMatchObject({
      lineage: ALT_LINEAGE,
      market: "AU",
      prereg_sha: PREREG_SHA,
      verdict: first.verdict,
    });
    const refused = { status: "refused", reason: "already_looked" };
    expect(await evaluateAlt(db, { market: "AU", now: () => NOW })).toEqual(refused);
    expect(await evaluateAlt(db, { market: "AU", now: () => "2031-01-01T00:00:00.000Z" })).toEqual(
      refused,
    );
    expect(await looks(db)).toBe(1);
  });

  it("an index that falls through the differing sessions has a positive difference; one that rises through them, fails", async () => {
    const falls = await world();
    await seed(falls, 200, 40, "falls");
    const a = await evaluateAlt(falls, { market: "AU", now: () => NOW });
    const flat = await world();
    await seed(flat, 200, 40, "rises");
    const b = await evaluateAlt(flat, { market: "AU", now: () => NOW });
    expect(a.status === "looked" && a.differencePpm).toBeGreaterThan(0);
    expect(a.status === "looked" && a.verdict).toBe("pass");
    expect(b.status === "looked" && b.verdict).toBe("fail");
  });

  it("unavailable readings are not part of the sample", async () => {
    const db = await world();
    await seed(db, 200, 40, "falls");
    await db.execute("DROP TRIGGER regime_alt_reading_no_update");
    await db.execute("UPDATE regime_alt_reading SET inputs_status = 'unavailable'");
    expect(await evaluateAlt(db, { market: "AU", now: () => NOW })).toMatchObject({
      status: "below_sample",
      sessions: 0,
    });
  });
});
