// @vitest-environment node
// TST-122 for runWhatIfAction (UX-119, ROL-102a; M7 T19b). Owner and Editor ask a what-if that is
// answered ONLY from the stored nightly rows. Covered: the guard runs FIRST and a refusal changes
// nothing, input validation, error codes, the limit of 5 runs a day per user (read from config; reset
// at 00:00 Melbourne, DST days included), determinism, no write to any main-database table, no
// external call, the audit event written before the answer, and revalidation.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paramsJson, resolveCohortParams } from "@/lib/arena/cohort";
import { setConfig } from "@/lib/config/store";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { runWhatIfAction } from "@/app/(app)/what-if/actions";
import {
  budgetFor,
  loadOptions,
  melbourneDayBounds,
  runWhatIf,
  runsToday,
} from "@/lib/whatif/service";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
let viewerId: number;

const asUser = (id: number, role: string) =>
  requireUser.mockResolvedValue({ id, email: `${role}@example.test`, name: null, role });

const form = (o: Record<string, string | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) fd.set(k, v);
  return fd;
};
// Monday 05 Oct 2026 12:00 Melbourne (AEDT).
const NOW = new Date("2026-10-05T01:00:00.000Z");
const COST = { kind: "cost", key: "E01", profile: "P3" };
const SHOCK = { kind: "shock", key: "E01", pct: "-10" };

const tableCounts = async (db: Client): Promise<Record<string, number>> => {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const r of t.rows) {
    const n = String(r.name);
    out[n] = Number((await db.execute(`SELECT COUNT(*) AS n FROM "${n}"`)).rows[0]!.n);
  }
  return out;
};
const whatIfAudits = async () => (await auditRows(auth)).filter((a) => a.action === "what_if.run");

async function stat(cohort: string, scope: string, metric: string, d: string, v: object) {
  await main.execute({
    sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)",
    args: [`r-${d}`, `${scope}:${cohort}`, metric, d, JSON.stringify(v)],
  });
}

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  const params = paramsJson(resolveCohortParams());
  for (const [ex, family] of [
    ["E01", "F1"],
    ["E02", "F2"],
  ] as const) {
    await main.execute({
      sql: `INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile)
            VALUES (?, 'AU', 'E', ?, 'U', 'v1', 'P5')`,
      args: [ex, family],
    });
    await main.execute({
      sql: `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
              cost_profile_version, rng_seed) VALUES (?, ?, '2026-09-01', 600000000, 'v1', ?, 1, 1)`,
      args: [`${ex}@2026-09-01`, ex, params],
    });
  }
  // E01 has nightly rows (an older night too: the newest must win); E02 has none yet.
  const c = "E01@2026-09-01";
  await stat(c, "cost", "recost:P5", "2026-10-02", {
    nav_micro: "1",
    liq_nav_micro: "1",
    fees_micro: "1",
  });
  await stat(c, "cost", "recost:P5", "2026-10-03", {
    nav_micro: "629000000",
    liq_nav_micro: "628000000",
    fees_micro: "1500000",
    stored_nav_micro: "629000000",
    fills: 3,
  });
  await stat(c, "cost", "recost:P3", "2026-10-03", {
    nav_micro: "629800000",
    liq_nav_micro: "628900000",
    fees_micro: "700000",
    stored_nav_micro: "629000000",
    fills: 3,
  });
  await stat(c, "shock", "shock:-10", "2026-10-03", {
    pct: -10,
    pnl_micro: "-12340000",
    value_micro: "123400000",
    nav_after_micro: "616660000",
    positions: 1,
  });
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  viewerId = await addUser(auth, { email: "viewer@example.test", role: "viewer" });
  asUser(ownerId, "owner");
});

describe("guard first", () => {
  it("asks for the what_if action before anything else, on the page path", async () => {
    await runWhatIfAction(form(COST));
    expect(requireUser).toHaveBeenCalledWith("what_if", "/what-if");
  });

  it("a Viewer is refused by the guard: nothing is read or written", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    const before = await tableCounts(main);
    await expect(runWhatIfAction(form(COST))).rejects.toThrow(/403/);
    expect(await tableCounts(main)).toEqual(before);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an anonymous visitor is redirected by the guard before any read", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(runWhatIfAction(form(COST))).rejects.toThrow(/REDIRECT/);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("the service refuses a Viewer even if a caller skipped the guard", async () => {
    const out = await runWhatIf(
      {
        mainDb: main,
        authDb: auth,
        env: process.env,
        meta: { ip: null, userAgent: null },
        now: () => NOW,
      },
      { id: viewerId, email: "v", name: null, role: "viewer" } as never,
      { kind: "cost", key: "E01", profile: "P3", pct: undefined },
    );
    expect(out.status).toBe(403);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("answers come from stored rows", () => {
  it("cost: the newest nightly row of the chosen profile against the strategy's own profile", async () => {
    const r = await runWhatIfAction(form(COST));
    expect(r).toMatchObject({
      ok: true,
      view: {
        execution: "E01",
        name: "Follow the trend",
        d: "2026-10-03",
        result: {
          kind: "cost",
          profile: "P3",
          ownProfile: "P5",
          liqNavMicro: 628_900_000,
          ownLiqNavMicro: 628_000_000,
          diffMicro: 900_000,
          feesMicro: 700_000,
          ownFeesMicro: 1_500_000,
        },
        // budget below
      },
      budget: { limit: 5, used: 1, remaining: 4 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/what-if");
  });

  it("shock: the stored price-move row", async () => {
    expect(await runWhatIfAction(form(SHOCK))).toMatchObject({
      ok: true,
      view: {
        d: "2026-10-03",
        result: {
          kind: "shock",
          pct: -10,
          pnlMicro: -12_340_000,
          valueMicro: 123_400_000,
          navAfterMicro: 616_660_000,
        },
      },
    });
  });

  it("is deterministic: the same question gives the same answer", async () => {
    const a = await runWhatIfAction(form(COST));
    const b = await runWhatIfAction(form(COST));
    expect((a as { view: unknown }).view).toEqual((b as { view: unknown }).view);
  });

  it("an Editor may run it; the audit event names the actor and the question, and comes first", async () => {
    asUser(editorId, "editor");
    expect(await runWhatIfAction(form(COST))).toMatchObject({ ok: true });
    const a = await whatIfAudits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor_user_id: editorId,
      target_type: "what_if",
      target_id: "E01:cost",
      ip: "9.9.9.9",
    });
    expect(a[0]!.detail).toMatchObject({
      kind: "cost",
      execution: "E01",
      profile: "P3",
      d: "2026-10-03",
    });
  });

  it("writes nothing to any main-database table and makes no external call", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("no external call allowed");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const before = await tableCounts(main);
    await runWhatIfAction(form(COST));
    await runWhatIfAction(form(SHOCK));
    await runWhatIfAction(form({ kind: "custom", key: "custom" }));
    expect(await tableCounts(main)).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the page options list the running strategies, the profiles and the stored shock steps", async () => {
    const o = await loadOptions(main);
    expect(o.strategies).toEqual([
      { id: "E01", name: "Follow the trend" },
      { id: "E02", name: "Good company, good news" },
    ]);
    expect(o.profiles).toEqual(["P0", "P1", "P2", "P3", "P4", "P5", "P5b", "stress"]);
    expect(o.shocks).toEqual([-30, -20, -10, 10, 20, 30]);
  });
});

describe("error codes", () => {
  const code = async (o: Record<string, string | undefined>) =>
    (await runWhatIfAction(form(o))) as { error?: string; ok?: true };
  const nothingHappened = async () => {
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await budgetFor(main, auth, ownerId, NOW)).used).toBe(0);
  };

  it("invalid: missing or odd kind, key, profile and percentage", async () => {
    for (const bad of [
      {},
      { ...COST, kind: undefined },
      { ...COST, kind: "sideways" },
      { ...COST, key: undefined },
      { ...COST, key: "E 01" },
      { ...COST, key: "x".repeat(41) },
      { ...COST, profile: undefined },
      { ...SHOCK, pct: undefined },
      { ...SHOCK, pct: "ten" },
      { ...SHOCK, pct: "-10.5" },
      { ...SHOCK, pct: "" },
    ]) {
      expect(await code(bad)).toEqual({ error: "invalid" });
    }
    await nothingHappened();
  });

  it("not_available: anything the stored tables cannot answer, without using the budget", async () => {
    expect(await code({ kind: "custom", key: "custom" })).toEqual({ error: "not_available" });
    expect(await code({ kind: "custom" })).toEqual({ error: "not_available" });
    expect(await code({ ...COST, profile: "P9" })).toEqual({ error: "not_available" });
    expect(await code({ ...SHOCK, pct: "15" })).toEqual({ error: "not_available" });
    expect(await code({ ...SHOCK, pct: "-50" })).toEqual({ error: "not_available" });
    await nothingHappened();
  });

  it("not_found: no such running strategy", async () => {
    expect(await code({ ...COST, key: "E99" })).toEqual({ error: "not_found" });
    await nothingHappened();
  });

  it("no_data: nothing stored yet for that strategy, and the budget is kept", async () => {
    expect(await code({ ...COST, key: "E02" })).toEqual({ error: "no_data" });
    expect(await code({ ...SHOCK, key: "E02" })).toEqual({ error: "no_data" });
    expect(await code({ ...SHOCK, pct: "30" })).toEqual({ error: "no_data" }); // E01 has only -10
    await nothingHappened();
  });

  it("unavailable: when the audit cannot be written there is no answer", async () => {
    vi.stubEnv("PII_HASH_KEY", "");
    expect(await code(COST)).toEqual({ error: "unavailable" });
    expect(await whatIfAudits()).toEqual([]);
  });

  it("unavailable: when the stored rows cannot be read", async () => {
    await main.execute("ALTER TABLE replay_stat RENAME TO replay_stat_gone");
    expect(await code(COST)).toEqual({ error: "unavailable" });
    expect(await whatIfAudits()).toEqual([]);
  });
});

describe("limit: 5 a day per user, reset at 00:00 Melbourne", () => {
  it("the sixth run of the day is refused with limit_reached and writes nothing", async () => {
    for (let i = 0; i < 5; i += 1)
      expect(await runWhatIfAction(form(COST))).toMatchObject({ ok: true });
    revalidatePath.mockReset();
    expect(await runWhatIfAction(form(COST))).toEqual({ error: "limit_reached" });
    expect(await whatIfAudits()).toHaveLength(5);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("is per user: another user's runs do not count", async () => {
    for (let i = 0; i < 5; i += 1) await runWhatIfAction(form(COST));
    asUser(editorId, "editor");
    expect(await runWhatIfAction(form(COST))).toMatchObject({
      ok: true,
      budget: { used: 1, remaining: 4 },
    });
  });

  it("reads the limit from config (0 turns what-ifs off, 2 allows two)", async () => {
    await setConfig(main, {
      key: "what_if_daily_limit_per_user",
      value: 2,
      userId: ownerId,
      now: NOW.toISOString(),
    });
    expect(await runWhatIfAction(form(COST))).toMatchObject({
      ok: true,
      budget: { limit: 2, remaining: 1 },
    });
    expect(await runWhatIfAction(form(COST))).toMatchObject({ ok: true, budget: { remaining: 0 } });
    expect(await runWhatIfAction(form(COST))).toEqual({ error: "limit_reached" });
    await setConfig(main, {
      key: "what_if_daily_limit_per_user",
      value: 0,
      userId: ownerId,
      now: NOW.toISOString(),
    });
    expect(await runWhatIfAction(form(COST))).toEqual({ error: "limit_reached" });
  });

  const ctx = (at: Date) => ({
    mainDb: main,
    authDb: auth,
    env: process.env,
    meta: { ip: null, userAgent: null },
    now: () => at,
  });
  const owner = () => ({ id: ownerId, email: "o", name: null, role: "owner" }) as never;

  it("the Melbourne day is 23 hours on 04 Oct 2026 and 25 hours on 05 Apr 2026", () => {
    const fwd = melbourneDayBounds(new Date("2026-10-04T05:00:00Z"));
    expect(fwd).toEqual({
      d: "2026-10-04",
      startIso: "2026-10-03T14:00:00.000Z",
      endIso: "2026-10-04T13:00:00.000Z",
    });
    expect(Date.parse(fwd.endIso) - Date.parse(fwd.startIso)).toBe(23 * 3_600_000);
    const back = melbourneDayBounds(new Date("2026-04-05T05:00:00Z"));
    expect(back).toEqual({
      d: "2026-04-05",
      startIso: "2026-04-04T13:00:00.000Z",
      endIso: "2026-04-05T14:00:00.000Z",
    });
    expect(Date.parse(back.endIso) - Date.parse(back.startIso)).toBe(25 * 3_600_000);
  });

  it("resets at midnight Melbourne, including the night the clocks go forward", async () => {
    const q = { kind: "cost", key: "E01", profile: "P3", pct: undefined };
    // 23:30 AEST on 03 Oct: five runs use the day up
    for (let i = 0; i < 5; i += 1)
      expect((await runWhatIf(ctx(new Date("2026-10-03T13:30:00Z")), owner(), q)).status).toBe(200);
    expect((await runWhatIf(ctx(new Date("2026-10-03T13:59:59Z")), owner(), q)).status).toBe(429);
    // 00:00 AEST on 04 Oct: a fresh day
    expect(await runsToday(auth, ownerId, new Date("2026-10-03T14:00:00Z"))).toBe(0);
    expect((await runWhatIf(ctx(new Date("2026-10-03T14:00:00Z")), owner(), q)).status).toBe(200);
    // the 23-hour day ends at 00:00 AEDT (13:00Z): 12:59:59Z is still 04 Oct, 13:00Z is 05 Oct
    expect(await runsToday(auth, ownerId, new Date("2026-10-04T12:59:59Z"))).toBe(1);
    expect(await runsToday(auth, ownerId, new Date("2026-10-04T13:00:00Z"))).toBe(0);
  });

  it("resets at midnight Melbourne, including the 25-hour day when the clocks go back", async () => {
    const q = { kind: "cost", key: "E01", profile: "P3", pct: undefined };
    // 00:30 AEDT on 05 Apr (13:30Z on 04 Apr) is the first hour of the 25-hour day
    for (let i = 0; i < 5; i += 1)
      expect((await runWhatIf(ctx(new Date("2026-04-04T13:30:00Z")), owner(), q)).status).toBe(200);
    // 02:30 AEST (the repeated hour) and 23:59 AEST are still the same day
    expect((await runWhatIf(ctx(new Date("2026-04-04T16:30:00Z")), owner(), q)).status).toBe(429);
    expect((await runWhatIf(ctx(new Date("2026-04-05T13:59:59Z")), owner(), q)).status).toBe(429);
    // 00:00 AEST on 06 Apr
    expect((await runWhatIf(ctx(new Date("2026-04-05T14:00:00Z")), owner(), q)).status).toBe(200);
    // and the run just before 00:00 AEDT on 05 Apr belongs to the day before
    expect(await runsToday(auth, ownerId, new Date("2026-04-04T12:59:59Z"))).toBe(0);
  });
});
