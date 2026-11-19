// @vitest-environment node
// Committee shortlist (M22 C1; AGT-132, D-1417): the top N signals of the session by rank score, ties by code, read-only,
// deterministic, bounded.
import { afterEach, describe, expect, it } from "vitest";
import { shortlist } from "@/lib/committee/shortlist";
import { cleanupTempDbs } from "../db/helpers";
import { D, MARKET, seedNight } from "./harness";

afterEach(cleanupTempDbs);

describe("shortlist", () => {
  it("takes the top signals by rank score, highest first", async () => {
    const db = await seedNight();
    const list = await shortlist(db, MARKET, D, 2);
    expect(list.map((x) => x.code)).toEqual(["ZZB", "ZZC"]); // 9.5, 5.0 (ZZA 1.5 is cut)
    expect(list[0]).toMatchObject({ signalId: "s2", cardId: "c2", rankScore: 9.5 });
  });

  it("is deterministic: the same rows give the same list on every call", async () => {
    const db = await seedNight();
    const a = await shortlist(db, MARKET, D, 3);
    const b = await shortlist(db, MARKET, D, 3);
    expect(b).toEqual(a);
    expect(a.map((x) => x.signalId)).toEqual(["s2", "s3", "s1"]);
  });

  it("breaks a tie on the rank score by code, then by signal id", async () => {
    const db = await seedNight();
    const add = (id: string, code: string) =>
      db.execute({
        sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
              VALUES (?, 'AU', ?, 'F3', 'v1', 'base', ?, 'NEUTRAL', '5.0', '[]', '{}', 1, 'a', 'r', '2026-03-04T07:10:00.000Z')`,
        args: [id, D, code],
      });
    await add("s9", "ZZ0"); // ties with s3 (ZZC, 5.0): ZZ0 and ZZ1 sort before ZZC
    await add("s8", "ZZ1");
    expect((await shortlist(db, MARKET, D, 5)).map((x) => `${x.code}:${x.signalId}`)).toEqual([
      "ZZB:s2",
      "ZZ0:s9",
      "ZZ1:s8",
      "ZZC:s3",
      "ZZA:s1",
    ]);
  });

  it("ranks numerically, not as text (10 above 9)", async () => {
    const db = await seedNight();
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES ('s7', 'AU', ?, 'F3', 'v1', 'base', 'ZZD', 'NEUTRAL', '10.25', '[]', '{}', 1, 'a', 'r', '2026-03-04T07:10:00.000Z')`,
      args: [D],
    });
    expect((await shortlist(db, MARKET, D, 1))[0]!.code).toBe("ZZD");
  });

  it("is empty for a count of 0, a negative or a non-number, and never more than the key's bound", async () => {
    const db = await seedNight();
    expect(await shortlist(db, MARKET, D, 0)).toEqual([]);
    expect(await shortlist(db, MARKET, D, -3)).toEqual([]);
    expect(await shortlist(db, MARKET, D, Number.NaN)).toEqual([]);
    expect((await shortlist(db, MARKET, D, 99)).length).toBe(3);
  });

  it("reads only the named session and market, and writes nothing", async () => {
    const db = await seedNight();
    expect(await shortlist(db, MARKET, "2026-03-05", 5)).toEqual([]);
    expect(await shortlist(db, "ZZ", D, 5)).toEqual([]);
    const before = Number((await db.execute("SELECT COUNT(*) AS n FROM signal")).rows[0]!.n);
    await shortlist(db, MARKET, D, 3);
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM signal")).rows[0]!.n)).toBe(before);
  });

  it("a signal without a decision card is listed with a null card id", async () => {
    const db = await seedNight();
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES ('s6', 'AU', ?, 'F3', 'v1', 'base', 'ZZE', 'NEUTRAL', '99', '[]', '{}', 1, 'a', 'r', '2026-03-04T07:10:00.000Z')`,
      args: [D],
    });
    expect((await shortlist(db, MARKET, D, 1))[0]).toMatchObject({ code: "ZZE", cardId: null });
  });
});
