// @vitest-environment node
// TST-135 (a), D-967 (AT-85 "every seed state loads"): each named e2e state loads onto a fresh migrated
// database and applying it again changes nothing. Plain SQL and synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import * as expertsSeed from "../../e2e/seed/experts";
import { applyStates, parseStates, STATE_NAMES, STATES } from "../../e2e/seed/states.mjs";
import * as expertsState from "../../e2e/seed/states/experts-queue.mjs";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2026-10-16T09:00:00.000Z";

async function counts(db: Client): Promise<Record<string, number>> {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const r of t.rows) {
    const n = await db.execute(`SELECT COUNT(*) AS n FROM "${String(r.name)}"`);
    out[String(r.name)] = Number(n.rows[0]!.n);
  }
  return out;
}

describe("the state registry", () => {
  it("names the six states of TST-135 (a) and the three of M21 A1 (D-1236)", () => {
    expect(STATE_NAMES).toEqual([
      "picks-two-sections",
      "experts-queue",
      "steelman-cards",
      "alerts-muted",
      "market-built-off",
      "blueprint-full",
      "owner-tools-on",
      "review-stored",
      "labels-queue",
    ]);
    for (const n of STATE_NAMES)
      expect(typeof STATES[n as keyof typeof STATES].apply).toBe("function");
  });

  it("parses lists and 'all', ignores blanks and repeats, and refuses an unknown name", () => {
    expect(parseStates(undefined)).toEqual([]);
    expect(parseStates("  ")).toEqual([]);
    // "all" is the default-configuration states: the Owner switch is opt-in (D-1243)
    expect(parseStates("all")).toEqual(STATE_NAMES.filter((n) => n !== "owner-tools-on"));
    expect(parseStates("all,owner-tools-on")).toEqual([...parseStates("all"), "owner-tools-on"]);
    expect(parseStates("owner-tools-on,all")).toEqual(["owner-tools-on", ...parseStates("all")]);
    expect(parseStates("alerts-muted, experts-queue,alerts-muted")).toEqual([
      "alerts-muted",
      "experts-queue",
    ]);
    expect(() => parseStates("alerts-muted,nope")).toThrow(/unknown e2e state "nope"/);
  });

  it("the experts constants the specs import equal the state's", () => {
    for (const k of ["EXPERT_A", "EXPERT_B", "NAME_A", "NAME_B", "FLAG_TEXT", "CLAIM_A"] as const) {
      expect(expertsSeed[k], k).toBe(expertsState[k]);
    }
  });
});

describe("every state loads, and applying it twice changes nothing", () => {
  for (const name of STATE_NAMES) {
    it(name, async () => {
      const db = await freshDb("main");
      const before = await counts(db);
      await applyStates(db, [name], NOW);
      const once = await counts(db);
      await applyStates(db, [name], NOW);
      expect(await counts(db)).toEqual(once);
      if (name === "market-built-off")
        expect(once).toEqual(before); // writes nothing
      else {
        const grown = Object.keys(once).filter((t) => once[t] !== before[t]);
        expect(grown.length, `${name} wrote something`).toBeGreaterThan(0);
      }
    });
  }

  it('all of them together, in order, and again; the Owner switch stays off under "all"', async () => {
    const db = await freshDb("main");
    await applyStates(db, parseStates("all"), NOW);
    const once = await counts(db);
    await applyStates(db, parseStates("all"), NOW);
    expect(await counts(db)).toEqual(once);
    expect(await getConfig(db, "owner_real_money_tools")).toBe("off");
    expect(Number(once.owner_trade)).toBe(0);
    await applyStates(db, parseStates("all,owner-tools-on"), NOW);
    expect(await getConfig(db, "owner_real_money_tools")).toBe("on");
  });
});

describe("what each state leaves behind", () => {
  it("owner-tools-on: the switch on, one AU trade and one holdings upload, nothing for another market", async () => {
    const db = await freshDb("main");
    const off = await getConfig(db, "owner_real_money_tools");
    expect(off).toBe("off");
    await applyStates(db, ["owner-tools-on"], NOW);
    expect(await getConfig(db, "owner_real_money_tools")).toBe("on");
    const t = await db.execute("SELECT market, side, source, entered_by FROM owner_trade");
    expect(t.rows.map((r) => [r.market, r.side, r.source])).toEqual([["AU", "buy", "typed"]]);
    const h = await db.execute("SELECT market, upload_id FROM owner_holding");
    expect(h.rows).toHaveLength(1);
    expect(String(h.rows[0]!.market)).toBe("AU");
    // the config key is written once, however often the state is applied
    await applyStates(db, ["owner-tools-on"], NOW);
    const v = await db.execute(
      "SELECT COUNT(*) AS n FROM config_version WHERE key = 'owner_real_money_tools'",
    );
    expect(Number(v.rows[0]!.n)).toBe(1);
  });

  it("review-stored: one stored Evening Review for the newest weekday, no other review", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["review-stored"], NOW);
    const r = await db.execute(
      "SELECT d, version, kind, narrative, length(html) AS n FROM evening_review",
    );
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0]!.d)).toBe("2026-10-16"); // NOW is a Friday
    expect([Number(r.rows[0]!.version), String(r.rows[0]!.kind)]).toEqual([1, "full"]);
    expect(Number(r.rows[0]!.n)).toBeGreaterThan(50);
    expect(String(r.rows[0]!.html)).not.toMatch(/<script/i); // the frame has no script (D-1203)
  });

  it("labels-queue: three AU announcements and no golden label", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["labels-queue"], NOW);
    const a = await db.execute("SELECT market, source FROM announcement");
    expect(a.rows.map((x) => [String(x.market), String(x.source)])).toEqual([
      ["AU", "asx"],
      ["AU", "asx"],
      ["AU", "asx"],
    ]);
    expect((await db.execute("SELECT 1 FROM golden_label")).rows).toHaveLength(0);
  });

  it("picks-two-sections: a published pick and a recorded intraday scan", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["picks-two-sections"], NOW);
    expect((await db.execute("SELECT code FROM pick")).rows.map((r) => String(r.code))).toEqual([
      "ZZPS",
    ]);
    expect(
      (await db.execute("SELECT status FROM run_record WHERE job = 'intraday-scan'")).rows,
    ).toHaveLength(1);
  });

  it("experts-queue: two experts, one proposed cluster, three claims waiting", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["experts-queue"], NOW);
    const n = async (t: string) =>
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
    expect([
      await n("expert"),
      await n("cluster"),
      await n("claim"),
      await n("expert_red_flag"),
    ]).toEqual([2, 1, 3, 1]);
  });

  it("steelman-cards: a card, a pack and four shown points, and no suggestion", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["steelman-cards"], NOW);
    expect((await db.execute("SELECT card_id FROM steelman_pack")).rows).toHaveLength(1);
    expect(
      (await db.execute("SELECT 1 FROM steelman_point WHERE state = 'shown'")).rows,
    ).toHaveLength(4);
    expect((await db.execute("SELECT 1 FROM steelman_suggestion")).rows).toHaveLength(0);
  });

  it("alerts-muted: armed then cleared as muted, mail off", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["alerts-muted"], NOW);
    const r = await db.execute("SELECT state, clear_reason FROM pick_alert ORDER BY seq");
    expect(
      r.rows.map((x) => [String(x.state), x.clear_reason === null ? null : String(x.clear_reason)]),
    ).toEqual([
      ["armed", null],
      ["cleared", "muted"],
    ]);
    expect(
      (await db.execute("SELECT status FROM pick_alert_mail")).rows.map((x) => String(x.status)),
    ).toEqual(["off"]);
  });

  it("market-built-off asserts the production shape: a second market stops the run", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["market-built-off"], NOW); // AU only: fine
    await db.execute(
      `INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode)
       VALUES ('ZQ', 'UTC', '10:00', '16:00', '16:10', 'XXX', 'off')`,
    );
    await expect(applyStates(db, ["market-built-off"], NOW)).rejects.toThrow(/expected markets AU/);
  });

  it("market-built-off stops the run when a built market is enabled", async () => {
    const db = await freshDb("main");
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    await expect(applyStates(db, ["market-built-off"], NOW)).rejects.toThrow(
      /expected markets AU enabled, found AU,IN/,
    );
  });

  it("blueprint-full: one successful run record per nightly job", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["blueprint-full"], NOW);
    const r = await db.execute("SELECT DISTINCT job FROM run_record WHERE status = 'success'");
    expect(r.rows).toHaveLength(8);
  });
});
