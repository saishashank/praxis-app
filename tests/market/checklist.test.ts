// @vitest-environment node
// M20 S1 (AT-71, MKT-111, D-1100): the switch-on checklist. Every item is driven open and closed by a planted state,
// so a regression in one reader cannot hide behind another. The production seed (IN/US off, pending sources, no
// evidence) must never be complete.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checklist,
  nfrLines,
  type ChecklistDeps,
  type ChecklistItemId,
} from "@/lib/market/checklist";
import { invalidateProfiles } from "@/lib/market/profile";
import { marketSourcesOf } from "@/lib/market/seed/sourceSites.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = new Date("2026-11-20T02:00:00.000Z"); // Fri 20 Nov 2026, 13:00 Melbourne
const TODAY = "2026-11-20";
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  invalidateProfiles();
});

const FITS: ChecklistDeps["quota"] = async () => ({ fits: true, text: "fits" });
const NOT_FITS: ChecklistDeps["quota"] = async () => ({
  fits: false,
  text: "Over the line: Turso rows read 21 %.",
});
const item = (c: Awaited<ReturnType<typeof checklist>>, id: ChecklistItemId) =>
  c.items.find((i) => i.id === id)!;

// ---- planted states ----------------------------------------------------------------------------------------------

async function completeProfile(code: string) {
  await db.execute({
    sql: "UPDATE market_profile_field SET verify = 0 WHERE code = ?",
    args: [code],
  });
  invalidateProfiles();
}
const recordEvidence = (code: string) =>
  db.execute({
    sql: "UPDATE market_profile SET evidence_recorded_at = '2026-11-12T00:00:00.000Z' WHERE code = ?",
    args: [code],
  });
async function acceptAllSources(code: string) {
  await allowMarket(db, code);
  await ensureMarketSources(db, code);
  await db.execute({
    sql: "UPDATE source_register SET status = 'enabled' WHERE substr(source, 1, 3) = ?",
    args: [`${code.toLowerCase()}_`],
  });
}
async function auCalendar(from: string, to: string) {
  for (
    let d = from;
    d <= to;
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  ) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    await db.execute({
      sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU', ?, 'session', 1, 'test')",
      args: [d],
    });
  }
}
const signOff = (at: string) =>
  db.execute({
    sql: `INSERT INTO go_live_signoff (market, signed_by, signed_at, release_commit, items_json, note, audit_ref)
          VALUES ('AU', 1, ?, 'abcdef1', '[]', '', 'audit:1')`,
    args: [at],
  });
/**
 * NFR-001…003 planted over the 30-day window (the AU calendar is seeded): a marker on each of the 22 sessions after
 * 21 Oct (the newest `late` of them at 19:46, the rest at 19:40), `reviews` review mails sent at 20:10, and no polls.
 */
async function greenNfr(o: { reviews?: number; late?: number } = {}) {
  const sessions = (
    await db.execute({
      sql: "SELECT d FROM trading_calendar WHERE market = 'AU' AND d > '2026-10-21' AND d <= ? ORDER BY d DESC",
      args: [TODAY],
    })
  ).rows.map((r) => String(r.d));
  expect(sessions).toHaveLength(22);
  for (const [i, d] of sessions.entries()) {
    await db.execute({
      sql: "INSERT INTO completion_marker (market, d, kind, at, outcome) VALUES ('AU', ?, 'data', ?, 'ok')",
      args: [d, i < (o.late ?? 0) ? `${d}T08:46:00.000Z` : `${d}T08:40:00.000Z`], // 19:46 / 19:40 Melbourne (AEDT)
    });
  }
  for (let i = 0; i < (o.reviews ?? 29); i++) {
    const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await db.execute({
      sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at, sent_at)
            VALUES (?, 'production', 'review', ?, 'reserved_review', 'sent', ?, ?)`,
      args: [`review:${d}`, d, `${d}T09:00:00.000Z`, `${d}T09:10:00.000Z`], // 20:10 Melbourne
    });
  }
}
async function auMeetsMkt105() {
  await signOff("2026-08-03T00:00:00.000Z");
  await auCalendar("2026-08-03", TODAY); // far more than 60 sessions
  await greenNfr();
}

describe("the production seed can never be complete (BLD-050)", () => {
  it.each(["IN", "US"])(
    "%s: the first step is open, with a named reason for each open item",
    async (code) => {
      const c = await checklist(db, code, NOW, {
        deps: { quota: FITS, reportListed: () => false },
      });
      expect(c.to).toBe("data_only");
      expect(c.complete).toBe(false);
      expect(c.items.map((i) => i.id)).toEqual([
        "profile_complete",
        "at_m_evidence",
        "licence_rows",
        "quota_projection",
        "au_mkt105",
      ]);
      const open = c.items.filter((i) => !i.ok);
      expect(open.length).toBeGreaterThanOrEqual(3);
      expect(open.every((i) => i.text.length > 10)).toBe(true);
      expect(item(c, "at_m_evidence").text).toContain("not recorded");
      expect(item(c, "au_mkt105").text).toContain("no go-live sign-off");
    },
  );

  it("refuses the home market and an unbuilt code", async () => {
    await expect(checklist(db, "AU", NOW)).rejects.toThrow(RangeError);
    await expect(checklist(db, "ZZ", NOW)).rejects.toThrow(RangeError);
  });
});

describe("profile_complete (DAT-242)", () => {
  it("is open with [VERIFY] fields undated, ok once every field is valued and verified", async () => {
    const deps = { quota: FITS, reportListed: () => true };
    expect(item(await checklist(db, "IN", NOW, { deps }), "profile_complete").ok).toBe(false);
    await completeProfile("IN");
    const after = item(await checklist(db, "IN", NOW, { deps }), "profile_complete");
    expect(after.text).toMatch(/complete|open/);
    // either the profile is now complete, or the named fields still missing a value are listed
    if (!after.ok) expect(after.text).toContain("open:");
  });
});

describe("at_m_evidence (MKT-114, AT-M)", () => {
  it("needs the recorded date AND the report listed in the test map", async () => {
    const run = (listed: boolean) =>
      checklist(db, "IN", NOW, { deps: { quota: FITS, reportListed: () => listed } });
    expect(item(await run(true), "at_m_evidence")).toMatchObject({
      ok: false,
      text: "AT-M evidence not recorded.",
    });
    await recordEvidence("IN");
    invalidateProfiles();
    expect(item(await run(false), "at_m_evidence").ok).toBe(false);
    expect(item(await run(false), "at_m_evidence").text).toContain("not listed in the test map");
    const ok = item(await run(true), "at_m_evidence");
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("2026-11-12");
    expect(ok.evidence).toBe("docs/test-reports/AT-M-IN.md");
  });

  it("reads the test map by default: the listing of the report names both markets", async () => {
    await recordEvidence("US");
    invalidateProfiles();
    const c = await checklist(db, "US", NOW, { deps: { quota: FITS } });
    expect(item(c, "at_m_evidence").evidence).toBe("docs/test-reports/AT-M-US.md");
    expect(item(c, "at_m_evidence").ok).toBe(true); // docs/test-map.md lists AT-M-US.md
  });
});

describe("licence_rows (DAT-120, D-1128)", () => {
  it("before the market is on, the seed rows are the state: pending ones block", async () => {
    const seeded = marketSourcesOf("IN");
    expect(seeded.length).toBeGreaterThan(5);
    const pending = seeded.filter((s) => s.status === "pending").length;
    expect(pending).toBeGreaterThan(0);
    const c = await checklist(db, "IN", NOW, { deps: { quota: FITS, reportListed: () => true } });
    const li = item(c, "licence_rows");
    expect(li.ok).toBe(false);
    expect(li.text).toContain(`${pending} of ${seeded.length} source rows are pending`);
    expect(li.evidence).toBe("docs/source-licence-register.md");
  });

  it("once every row is decided (enabled, or disabled for an optional source) it is ok; one pending row re-opens it", async () => {
    await acceptAllSources("IN");
    const deps = { quota: FITS, reportListed: () => true };
    expect(item(await checklist(db, "IN", NOW, { deps }), "licence_rows").ok).toBe(true);
    await db.execute("UPDATE source_register SET status = 'disabled' WHERE source = 'in_rbi'");
    expect(item(await checklist(db, "IN", NOW, { deps }), "licence_rows").ok).toBe(true);
    await db.execute("UPDATE source_register SET status = 'pending' WHERE source = 'in_mospi'");
    const open = item(await checklist(db, "IN", NOW, { deps }), "licence_rows");
    expect(open.ok).toBe(false);
    expect(open.text).toContain("in_mospi");
  });
});

describe("quota_projection (MKT-113)", () => {
  it("follows the projection verdict and names what is over the line", async () => {
    const fits = item(
      await checklist(db, "US", NOW, { deps: { quota: FITS } }),
      "quota_projection",
    );
    expect(fits).toMatchObject({ ok: true, evidence: "/usage#projection" });
    const over = item(
      await checklist(db, "US", NOW, { deps: { quota: NOT_FITS } }),
      "quota_projection",
    );
    expect(over.ok).toBe(false);
    expect(over.text).toContain("Turso rows read 21 %");
  });
  it("an unreadable projection is open, never ok", async () => {
    const boom: ChecklistDeps["quota"] = async () => {
      throw new Error("db down");
    };
    const q = item(await checklist(db, "US", NOW, { deps: { quota: boom } }), "quota_projection");
    expect(q.ok).toBe(false);
  });
  it("by default reads the real projection: with no AU universe snapshot there is none, so it is open", async () => {
    const q = item(await checklist(db, "US", NOW), "quota_projection");
    expect(q.ok).toBe(false);
    expect(q.text).toContain("No projection yet");
  });
});

describe("au_mkt105 (MKT-105): sign-off age, incidents, the 30-day lines", () => {
  const deps = { quota: FITS, reportListed: () => true };
  const au = async () => item(await checklist(db, "IN", NOW, { deps }), "au_mkt105");

  it("is open without a sign-off", async () => {
    expect((await au()).text).toContain("no go-live sign-off");
  });

  // Fri 28 Aug 2026 + 12 whole weeks = Fri 20 Nov 2026: the sessions after 28 Aug up to 20 Nov are 12 x 5 = 60;
  // after Mon 31 Aug they are 59.
  it.each([
    ["2026-08-28T00:00:00.000Z", 60, true],
    ["2026-08-31T00:00:00.000Z", 59, false],
  ])("a sign-off on %s leaves %i AU trading days: ok = %s", async (at, days, ok) => {
    await signOff(at);
    await auCalendar("2026-08-24", TODAY);
    await greenNfr();
    const r = await au();
    expect(r.ok).toBe(ok);
    if (!ok) expect(r.text).toContain(`AU live ${days} of 60 trading days`);
  });

  it("an open S1 or S2 incident blocks; an S3 or a resolved one does not", async () => {
    await auMeetsMkt105();
    expect((await au()).ok).toBe(true);
    await db.execute(
      "INSERT INTO incident (at, severity, kind) VALUES ('2026-11-19T00:00:00Z', 'S3', 'x')",
    );
    await db.execute(
      "INSERT INTO incident (at, severity, kind, resolved_at) VALUES ('2026-11-18T00:00:00Z', 'S1', 'x', '2026-11-18T01:00:00Z')",
    );
    expect((await au()).ok).toBe(true);
    await db.execute(
      "INSERT INTO incident (at, severity, kind) VALUES ('2026-11-19T00:00:00Z', 'S2', 'x')",
    );
    const r = await au();
    expect(r.ok).toBe(false);
    expect(r.text).toContain("1 open S1 or S2 incident");
  });

  // 22 AU sessions in the window: 95 % needs 21 on time (21 x 100 >= 95 x 22), so one late marker passes and two fail.
  it.each([
    [1, true, "21 of 22"],
    [2, false, "20 of 22"],
  ])("NFR-001: %i late marker(s) -> ok = %s (%s on time)", async (late, ok, text) => {
    await greenNfr({ late });
    const l = (await nfrLines(db, TODAY)).find((x) => x.id === "NFR-001")!;
    expect(l.ok).toBe(ok);
    expect(l.text).toContain(text);
  });

  it("NFR-002: 98 % of scheduled polls (the line is exact); no scheduled poll is vacuously met", async () => {
    await auMeetsMkt105();
    const put = (ok: number, nm: number, failed: number, scheduled: number) =>
      db.execute({
        sql: `INSERT OR REPLACE INTO sentinel_poll_day (market, source, d, scheduled, ok, not_modified, failed)
              VALUES ('AU', 'asx', '2026-11-19', ?, ?, ?, ?)`,
        args: [scheduled, ok, nm, failed],
      });
    await put(90, 8, 2, 100); // 98 of 100: exactly on the line
    expect((await nfrLines(db, TODAY)).find((l) => l.id === "NFR-002")!.ok).toBe(true);
    await put(90, 7, 3, 100); // 97 of 100
    const bad = (await nfrLines(db, TODAY)).find((l) => l.id === "NFR-002")!;
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("97 of 100");
  });

  it.each([
    [28, true],
    [27, false],
  ])(
    "NFR-003: %i timely reviews of the last 30 days -> ok = %s (28 is the line)",
    async (reviews, ok) => {
      await greenNfr({ reviews });
      const l = (await nfrLines(db, TODAY)).find((x) => x.id === "NFR-003")!;
      expect(l.ok).toBe(ok);
      expect(l.text).toContain(`${reviews} of the last 30`);
    },
  );
});

describe("the second step: five_green_days and latency_measured (D-1100, D-1105)", () => {
  const deps = { quota: FITS, reportListed: () => true };
  const step2 = async () => checklist(db, "IN", NOW, { to: "full", deps });
  const sessionsIn = async (days: string[]) => {
    for (const d of days) {
      await db.execute({
        sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('IN', ?, 'session', 1, 't')",
        args: [d],
      });
    }
  };
  const verdict = async (d: string, pass: number, tiers = ["U1", "U2", "U3"]) => {
    for (const t of tiers) {
      await db.execute({
        sql: "INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES ('IN', ?, ?, 1, 1, 1.0, ?)",
        args: [d, t, pass],
      });
    }
  };
  const DAYS = ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];

  beforeEach(async () => {
    await allowMarket(db, "IN");
    await db.execute(
      "UPDATE market SET mode = 'data_only', data_only_since = '2026-11-12' WHERE code = 'IN'",
    );
  });

  it("the second step lists seven items; the first step only five", async () => {
    expect((await step2()).items.map((i) => i.id)).toEqual([
      "profile_complete",
      "at_m_evidence",
      "licence_rows",
      "quota_projection",
      "au_mkt105",
      "five_green_days",
      "latency_measured",
    ]);
    expect((await checklist(db, "IN", NOW, { to: "data_only", deps })).items).toHaveLength(5);
  });

  it("is open with fewer than five completed sessions since data_only_since, and counts only before today", async () => {
    await sessionsIn(["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-20"]); // 20 Nov is today: not completed
    for (const d of ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"]) await verdict(d, 1);
    const r = item(await step2(), "five_green_days");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("4 of 5 completed trading days");
  });

  it("five green sessions pass; one red tier, or a missing tier row, on any of the last five fails and is named", async () => {
    await sessionsIn(DAYS);
    for (const d of DAYS) await verdict(d, 1);
    expect(item(await step2(), "five_green_days").ok).toBe(true);
    // the five newest sessions are 13, 16, 17, 18, 19 Nov: the 12th is outside them
    const fresh = async (bad: { d: string; pass: number; tiers?: string[] }) => {
      db = await freshDb("main");
      invalidateProfiles();
      await allowMarket(db, "IN");
      await db.execute(
        "UPDATE market SET mode = 'data_only', data_only_since = '2026-11-12' WHERE code = 'IN'",
      );
      await sessionsIn(DAYS);
      for (const d of DAYS) if (d !== bad.d) await verdict(d, 1);
      await verdict(bad.d, bad.pass, bad.tiers);
      return item(await step2(), "five_green_days");
    };
    const red = await fresh({ d: "2026-11-17", pass: 0 });
    expect(red.ok).toBe(false);
    expect(red.text).toContain("2026-11-17");
    const partial = await fresh({ d: "2026-11-18", pass: 1, tiers: ["U1", "U2"] });
    expect(partial.ok).toBe(false);
    expect(partial.text).toContain("2026-11-18");
    expect((await fresh({ d: "2026-11-12", pass: 0 })).ok).toBe(true); // older than the last five: not counted
  });

  it("is open for a market that never entered data_only", async () => {
    await db.execute("UPDATE market SET data_only_since = NULL WHERE code = 'IN'");
    expect(item(await step2(), "five_green_days").text).toContain("has not been in data_only");
  });

  it("latency: 9 samples open, 10 ok", async () => {
    const put = (n: number) =>
      db.execute({
        sql: "INSERT INTO bar_latency_sample (market, d, close_local, first_seen_at, latency_min, source) VALUES ('IN', ?, '15:30', 'x', 45, 'test')",
        args: [`2026-10-${String(n).padStart(2, "0")}`],
      });
    for (let i = 1; i <= 9; i++) await put(i);
    const nine = item(await step2(), "latency_measured");
    expect(nine).toMatchObject({ ok: false, text: "9 of 10 bar-latency samples measured." });
    await put(10);
    expect(item(await step2(), "latency_measured").ok).toBe(true);
  });
});

describe("complete (every item of the step ok)", () => {
  it("is true for the first step with every item planted ok, and false when any single item is flipped back", async () => {
    await completeProfile("IN");
    await recordEvidence("IN");
    invalidateProfiles();
    await acceptAllSources("IN");
    await auMeetsMkt105();
    const run = (d: ChecklistDeps) => checklist(db, "IN", NOW, { deps: d });
    const profileOk = item(
      await run({ quota: FITS, reportListed: () => true }),
      "profile_complete",
    ).ok;
    const c = await run({ quota: FITS, reportListed: () => true });
    expect(c.complete).toBe(profileOk && c.items.every((i) => i.ok));
    if (profileOk) {
      expect(c.complete).toBe(true);
      expect((await run({ quota: NOT_FITS, reportListed: () => true })).complete).toBe(false);
      expect((await run({ quota: FITS, reportListed: () => false })).complete).toBe(false);
    }
  });
});
