// @vitest-environment node
// TST-135 (a), D-967 (AT-85 "every seed state loads"): each named e2e state loads onto a fresh migrated
// database and applying it again changes nothing. Plain SQL and synthetic ZZ data only.
import { createHash } from "node:crypto";
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
  it("names the six states of TST-135 (a), the three of M21 A1 (D-1236) and the two of M22 A1 (D-1444)", () => {
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
      "committee-trial",
      "experts-sources",
      "cortex-research",
    ]);
    expect(STATE_NAMES).toHaveLength(12);
    for (const n of STATE_NAMES)
      expect(typeof STATES[n as keyof typeof STATES].apply).toBe("function");
  });

  it("parses lists and 'all', ignores blanks and repeats, and refuses an unknown name", () => {
    expect(parseStates(undefined)).toEqual([]);
    expect(parseStates("  ")).toEqual([]);
    // "all" is the default-configuration states: the Owner switch (D-1243) and the Committee switch are opt-in
    const OPT_IN = ["owner-tools-on", "committee-trial"];
    expect(parseStates("all")).toEqual(STATE_NAMES.filter((n) => !OPT_IN.includes(n)));
    expect(parseStates("all")).toContain("experts-sources");
    expect(parseStates("all,owner-tools-on")).toEqual([...parseStates("all"), "owner-tools-on"]);
    expect(parseStates("all,committee-trial")).toEqual([...parseStates("all"), "committee-trial"]);
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

  it('all of them together, in order, and again; the Owner and Committee switches stay off under "all"', async () => {
    const db = await freshDb("main");
    await applyStates(db, parseStates("all"), NOW);
    const once = await counts(db);
    await applyStates(db, parseStates("all"), NOW);
    expect(await counts(db)).toEqual(once);
    expect(await getConfig(db, "owner_real_money_tools")).toBe("off");
    expect(Number(once.owner_trade)).toBe(0);
    expect(await getConfig(db, "committee_enabled")).toBe("off");
    expect(Number(once.committee_rating)).toBe(0);
    expect(Number(once.expert_call_proposal)).toBe(2);
    await applyStates(db, parseStates("all,owner-tools-on"), NOW);
    expect(await getConfig(db, "owner_real_money_tools")).toBe("on");
    expect(await getConfig(db, "committee_enabled")).toBe("off");
    await applyStates(db, parseStates("all,committee-trial"), NOW);
    expect(await getConfig(db, "committee_enabled")).toBe("on");
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

  it("committee-trial: the switch on, one pre-registration with a matching sha, three nights of three ratings, three interim rows", async () => {
    const db = await freshDb("main");
    expect(await getConfig(db, "committee_enabled")).toBe("off");
    await applyStates(db, ["committee-trial"], NOW);
    expect(await getConfig(db, "committee_enabled")).toBe("on");
    const p = await db.execute(
      "SELECT trial_id, version, market, frozen_json, sha FROM committee_prereg",
    );
    expect(p.rows).toHaveLength(1);
    expect([String(p.rows[0]!.version), String(p.rows[0]!.market)]).toEqual(["1", "AU"]);
    expect(String(p.rows[0]!.sha)).toBe(
      createHash("sha256").update(String(p.rows[0]!.frozen_json)).digest("hex"),
    );
    const r = await db.execute("SELECT d, rating FROM committee_rating ORDER BY d, signal_id");
    expect(r.rows).toHaveLength(9);
    expect(new Set(r.rows.map((x) => String(x.d))).size).toBe(3);
    expect(new Set(r.rows.map((x) => String(x.rating)))).toEqual(
      new Set(["approve", "neutral", "reject"]),
    );
    const t = await db.execute("SELECT kind, verdict FROM committee_trial_result");
    expect(t.rows.map((x) => [String(x.kind), String(x.verdict)])).toEqual([
      ["interim", "running"],
      ["interim", "running"],
      ["interim", "running"],
    ]);
    // the config key is written once, however often the state is applied
    await applyStates(db, ["committee-trial"], NOW);
    const v = await db.execute(
      "SELECT COUNT(*) AS n FROM config_version WHERE key = 'committee_enabled'",
    );
    expect(Number(v.rows[0]!.n)).toBe(1);
  });

  it("experts-sources: a tracked expert with an enabled licence, a candidate with an unchecked one, a complete and an incomplete proposal", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["experts-sources"], NOW);
    const e = await db.execute("SELECT id, status, tier FROM expert ORDER BY id");
    expect(e.rows.map((x) => [String(x.id), String(x.status), String(x.tier)])).toEqual([
      ["X-SRC1", "tracked", "core"],
      ["X-SRC2", "candidate", "discovered"],
    ]);
    const l = await db.execute(
      "SELECT expert_id, status FROM expert_source_licence ORDER BY expert_id",
    );
    expect(l.rows.map((x) => [String(x.expert_id), String(x.status)])).toEqual([
      ["X-SRC1", "enabled"],
      ["X-SRC2", "unchecked"],
    ]);
    const p = await db.execute("SELECT state, claim_id FROM expert_call_proposal ORDER BY state");
    expect(p.rows.map((x) => String(x.state))).toEqual(["complete", "incomplete"]);
    // the complete proposal can be confirmed (the 0042 guard accepts it); the incomplete one cannot
    await db.execute(
      "INSERT INTO expert_call_confirm (claim_id, proposal_id, price_basis, confirmed_by, confirmed_at) VALUES ('C-SRC-1', '" +
        "c".repeat(64) +
        "', 'close', 'owner', '2026-10-16T09:00:00Z')",
    );
    await expect(
      db.execute(
        "INSERT INTO expert_call_confirm (claim_id, proposal_id, price_basis, confirmed_by, confirmed_at) VALUES ('C-SRC-2', '" +
          "d".repeat(64) +
          "', 'close', 'owner', '2026-10-16T09:00:00Z')",
      ),
    ).rejects.toThrow(/complete proposal/);
  });

  it("cortex-research: three looks with matching plans, one refusal, the meters, eight monitors, one night of groups and two proposals", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["cortex-research"], NOW);
    const one = async (sql: string) => Number((await db.execute(sql)).rows[0]!.n);
    expect(await one("SELECT COUNT(*) AS n FROM holdout_look")).toBe(3);
    expect(
      await one(
        "SELECT COUNT(*) AS n FROM holdout_look h JOIN research_prereg p ON p.lineage = h.lineage AND p.market = h.market AND p.sha = h.prereg_sha",
      ),
    ).toBe(3);
    expect(await one("SELECT COUNT(*) AS n FROM holdout_look_refusal")).toBe(1);
    expect(await one("SELECT COUNT(*) AS n FROM research_meter")).toBe(4);
    expect(await one("SELECT COUNT(DISTINCT monitor) AS n FROM residual_monitor")).toBe(8);
    expect(await one("SELECT COUNT(*) AS n FROM sector_index")).toBe(3);
    expect(await one("SELECT COUNT(*) AS n FROM angle_proposal")).toBe(2);
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

  it("alerts-muted: the alert belongs to the viewer id it is given, so My alerts finds it", async () => {
    const db = await freshDb("main");
    await applyStates(db, ["alerts-muted"], NOW, { viewerId: "7" });
    await applyStates(db, ["alerts-muted"], NOW, { viewerId: "7" }); // idempotent
    const r = await db.execute("SELECT DISTINCT user_id FROM pick_alert");
    expect(r.rows.map((x) => String(x.user_id))).toEqual(["7"]);
    expect((await db.execute("SELECT 1 FROM pick_alert")).rows).toHaveLength(2);
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
