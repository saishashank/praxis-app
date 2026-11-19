// @vitest-environment node
// Monthly "Unproven notes" in the Evening Review (M22 C3; AGT-146, D-1425): the first review of each month lists at most 10 of
// last month's written pick reflections under the fixed words "AI-written, not tested"; a `not_written` row, an older or a
// newer reflection and every other day show nothing; the section is soft (a failing read never breaks the review) and is
// rendered in the e-mail text. Synthetic ZZ data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { renderReview } from "@/lib/email/templates";
import { buildFacts } from "@/lib/review/assemble";
import {
  isFirstReviewOfMonth,
  loadCtx,
  readUnprovenNotes,
  UNPROVEN_NOTES_CAPTION,
  UNPROVEN_NOTES_MAX,
  UNPROVEN_NOTES_TITLE,
} from "@/lib/review/sections";
import { cleanupTempDbs } from "../db/helpers";
import { APP, D, exec, MARKET, mainWorld, tradingDay } from "./helpers";

afterEach(cleanupTempDbs);

const FIRST = "2026-11-02"; // Monday, the first session of November 2026
const NOW = new Date("2026-11-02T09:30:00.000Z");
const SHA = "c".repeat(64);
const opts = (d: string) => ({
  market: MARKET,
  d,
  env: "production" as const,
  appUrl: APP,
  now: NOW,
});

async function addPick(db: Client, d: string, profile: string, rank: number, code: string) {
  await exec(
    db,
    `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
       reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro, risk_micro,
       factors_json, based_on_json, pick_sha, created_at)
     VALUES ('AU', ?, ?, ?, ?, 'F1', 'U1', 'F1.v1', 's', 'UNVALIDATED', 10000000, 10050000, '2026-12-31', 9200000,
       11000000, 50, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    [d, profile, rank, code, SHA, `${d}T07:00:00.000Z`],
  );
}

async function addReflection(
  db: Client,
  d: string,
  profile: string,
  rank: number,
  state: "written" | "not_written",
  createdAt: string,
  text = `Note for ${d} ${profile} ${rank}.`,
) {
  await exec(
    db,
    `INSERT INTO pick_reflection (market, d, profile, rank, text, agreed_point_ids_json, provider, model, state, reason, created_at)
     VALUES ('AU', ?, ?, ?, ?, '[]', 'alpha', 'alpha-model', ?, ?, ?)`,
    [
      d,
      profile,
      rank,
      state === "written" ? text : "",
      state,
      state === "written" ? null : "not available tonight",
      createdAt,
    ],
  );
}

/** Twelve written reflections created in October, one not_written one, one from September and one from November. */
async function world(): Promise<Client> {
  const db = await mainWorld();
  for (let r = 1; r <= 10; r += 1) await addPick(db, "2026-10-05", "balanced", r, `ZZ${r}`);
  await addPick(db, "2026-10-05", "steady", 1, "ZZS1");
  await addPick(db, "2026-10-05", "steady", 2, "ZZS2");
  await addPick(db, "2026-08-31", "balanced", 1, "ZZOLD");
  await addPick(db, "2026-10-28", "balanced", 1, "ZZNEW");
  for (let r = 1; r <= 10; r += 1)
    await addReflection(
      db,
      "2026-10-05",
      "balanced",
      r,
      "written",
      `2026-10-2${r % 10}T09:00:00.000Z`,
    );
  await addReflection(db, "2026-10-05", "steady", 1, "written", "2026-10-30T09:00:00.000Z");
  await addReflection(db, "2026-10-05", "steady", 2, "not_written", "2026-10-30T09:00:00.000Z");
  await addReflection(db, "2026-08-31", "balanced", 1, "written", "2026-09-30T09:00:00.000Z");
  await addReflection(db, "2026-10-28", "balanced", 1, "written", "2026-11-01T22:00:00.000Z");
  return db;
}

describe("first review of the month", () => {
  const cal = [] as const;
  it("is the first trading day of its month and no other day", () => {
    expect(isFirstReviewOfMonth("2026-11-02", cal)).toBe(true); // 1 November is a Sunday
    expect(isFirstReviewOfMonth("2026-11-03", cal)).toBe(false);
    expect(isFirstReviewOfMonth("2026-11-01", cal)).toBe(false); // not a trading day
    expect(isFirstReviewOfMonth("2026-10-01", cal)).toBe(true); // a Thursday
    expect(isFirstReviewOfMonth("2026-10-02", cal)).toBe(false);
    expect(isFirstReviewOfMonth("2026-08-03", cal)).toBe(true); // 1 August is a Saturday
    expect(isFirstReviewOfMonth("2026-08-04", cal)).toBe(false);
  });
  it("a holiday on the first weekday moves it to the next session", () => {
    const holiday = [{ d: "2026-01-01", kind: "holiday", close_time: null, confirmed: 1 }] as const;
    expect(isFirstReviewOfMonth("2026-01-01", holiday)).toBe(false);
    expect(isFirstReviewOfMonth("2026-01-02", holiday)).toBe(true);
  });
});

describe("readUnprovenNotes", () => {
  it("lists at most 10 written reflections created last month, with the fixed words", async () => {
    const db = await world();
    const f = await readUnprovenNotes(await loadCtx(db, opts(FIRST)));
    expect(f).not.toBeNull();
    expect(f!.title).toBe(UNPROVEN_NOTES_TITLE);
    expect(f!.caption).toBe("AI-written, not tested");
    expect(UNPROVEN_NOTES_CAPTION).toBe("AI-written, not tested");
    expect(f!.lines).toHaveLength(UNPROVEN_NOTES_MAX);
    const codes = f!.lines.map((l) => l.code);
    for (const bad of ["ZZOLD", "ZZNEW", "ZZS2"]) expect(codes).not.toContain(bad);
    for (const l of f!.lines) expect(l.text).toMatch(/^Note for 2026-10-05/);
  });

  it("is absent on every other day of the month", async () => {
    const db = await world();
    for (const d of ["2026-11-03", "2026-11-04", "2026-10-19"])
      expect(await readUnprovenNotes(await loadCtx(db, opts(d))), d).toBeNull();
  });

  it("is absent when nothing was written last month (not_written rows show nothing)", async () => {
    const db = await mainWorld();
    await addPick(db, "2026-10-05", "balanced", 1, "ZZ1");
    await addReflection(db, "2026-10-05", "balanced", 1, "not_written", "2026-10-30T09:00:00.000Z");
    expect(await readUnprovenNotes(await loadCtx(db, opts(FIRST)))).toBeNull();
  });
});

describe("in the review", () => {
  it("buildFacts carries the section in the first review of the month and not in another", async () => {
    const db = await world();
    const first = await buildFacts(db, opts(FIRST));
    expect(first.facts.unprovenNotes?.lines).toHaveLength(UNPROVEN_NOTES_MAX);
    const other = await buildFacts(db, opts("2026-11-03"));
    expect(other.facts.unprovenNotes).toBeUndefined();
  });

  it("a failing read leaves the section out and the review stands", async () => {
    const db = await world();
    await exec(db, "ALTER TABLE pick_reflection RENAME TO pick_reflection_gone");
    const built = await buildFacts(db, opts(FIRST));
    expect(built.facts.unprovenNotes).toBeUndefined();
  });

  it("the e-mail text names the section, the fixed words and each note", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts } = await buildFacts(db, opts(D));
    const withNotes = {
      ...facts,
      unprovenNotes: {
        title: UNPROVEN_NOTES_TITLE,
        caption: UNPROVEN_NOTES_CAPTION,
        lines: [{ code: "ZZ1", text: "It ended behind the market." }],
      },
    };
    const out = renderReview(withNotes);
    expect(out.text).toContain("Unproven notes");
    expect(out.text).toContain("AI-written, not tested");
    expect(out.text).toContain("ZZ1: It ended behind the market.");
    expect(renderReview(facts).text).not.toContain("Unproven notes");
  });
});
