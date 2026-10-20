// @vitest-environment node
// Risk overview, Tonight's trade ideas and the rebuilt Decision Card (M7 T13; UX-040, UX-041, UX-050,
// UXN-104, 120 to 123, 126, 150, 152; D-129, D-135 draft): loader additions and page output per role.
// Masking: Owner (and an Editor with a live unmask grant) see real values; an Editor without a grant,
// a Viewer and an anonymous visitor never receive a code, a company name, a stored id, a link, a price
// of a single trade or a note's text. Synthetic ZZ data on the real migrations.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import {
  CARD_UP,
  COHORT_E01,
  COHORT_E02,
  D,
  EDITOR,
  emptyDbs,
  leaks,
  NOW,
  OWNER,
  seedPopulated,
  SIG_UP,
  VIEWER,
  type Both,
} from "../loaders/seed";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown, reads: 0 }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({
  mainDb: () => {
    mem.reads += 1;
    return mem.main;
  },
  authDb: () => mem.auth,
}));

import CardPage from "@/app/(app)/cards/[id]/page";
import IdeasPage from "@/app/(app)/strategies/ideas/page";
import RiskPage from "@/app/(app)/strategies/risk/page";
import { cardRef } from "@/lib/ui/loaders/cards";
import { loadIdeas } from "@/lib/ui/loaders/ideas";
import { loadRisk } from "@/lib/ui/loaders/risk";
import { loadCardPage } from "@/lib/ui/loaders/cards";

let db: Both;

const run = (sql: string, args: Array<string | number | null> = []) =>
  db.main.execute({ sql, args });

/** A forward ledger row of SIG_UP (cost 100 A$M): closed at `out` per share. */
async function ledger(id: string, signal: string, out: number | null) {
  await run(
    `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, qty, fill_in_micro, brok_in_micro,
       stress_in_micro, timed, forward) VALUES (?, ?, NULL, '2026-10-12', 10, 10000000, 0, 10000000, 0, 1)`,
    [id, signal],
  );
  if (out === null) return;
  await run(
    `UPDATE ledger_row SET exit_d = '2026-10-16', exit_tag = 'IS', fill_out_micro = ?, brok_out_micro = 0,
       stress_out_micro = ?, qty_out = 10, gross_num = 0, gross_den = 1 WHERE id = ?`,
    [out, out * 10, id],
  );
}

beforeAll(async () => {
  db = await emptyDbs();
  await seedPopulated(db);
  // A second round-trip of shocks: E02 sits just above the loss limit (310 of 300).
  await run(
    "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('r1', ?, 'shock:-10', ?, ?)",
    [`shock:${COHORT_E02}`, D, JSON.stringify({ pct: -10, pnl_micro: "-5000000" })],
  );
  await run(
    "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('r1', ?, 'shock:-30', ?, ?)",
    [`shock:${COHORT_E02}`, D, JSON.stringify({ pct: -30, pnl_micro: "-30000000" })],
  );
  // Factor buckets of F1.v1 (split 1) and 50 closed forward trades: 40 inside the card's range.
  for (const [bucket, n, med] of [
    [1, 40, 30_000],
    [2, 14, 5_000],
    [3, 33, -20_000],
  ] as const) {
    await run(
      `INSERT INTO factor_bucket_stat (market, family, rule_version, split_version, factor, bucket, edges_json, n,
         median_net_ppm, family_median_ppm) VALUES ('AU','F1','F1.v1',1,'volume_ratio',?, '[5,8]', ?, ?, 10000)`,
      [bucket, n, med],
    );
  }
  for (let i = 0; i < 40; i += 1) await ledger(`L-in-${i}`, SIG_UP, 10_100_000); // +1 %
  for (let i = 0; i < 10; i += 1) await ledger(`L-out-${i}`, SIG_UP, 9_000_000); // -10 %
  await db.auth.execute({
    sql: "INSERT INTO annotation (subject_kind, subject_id, author_id, text, created_at) VALUES ('card', ?, ?, ?, ?)",
    args: [CARD_UP, EDITOR.id, "ZZUP looks cheap to me.", "2026-10-19T09:00:00.000Z"],
  });
});

afterAll(cleanupTempDbs);

afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireUser.mockReset();
  mem.main = db.main;
  mem.auth = db.auth;
  mem.reads = 0;
});

const as = (u: { id: number; role: string }) =>
  requireUser.mockResolvedValue({ ...u, email: `${u.role}@example.test`, name: null });
const risk = async () => renderToStaticMarkup(await RiskPage());
const ideas = async () =>
  renderToStaticMarkup(await IdeasPage({ searchParams: Promise.resolve({}) }));
const card = async (id: string) =>
  renderToStaticMarkup(await CardPage({ params: Promise.resolve({ id }) }));

// ---- Risk loader ------------------------------------------------------------------------------

describe("risk loader (UXN-104, 150, 152; UX-050)", () => {
  it("gives each position its thesis-breaker status and each strategy a bust bar input", async () => {
    const r = await loadRisk({ mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW });
    const e01 = r.data.strategies.find((s) => s.execution === "E01")!;
    expect(e01.positions[0]).toMatchObject({ stock: "ZZUP", breaker: "red", execution: "E01" });
    expect(e01.bust?.micro).toBe(300_000_000);
    expect(e01.seed.micro).toBe(600_000_000);
    expect(e01.nearBust).toBe(false);
    const e02 = r.data.strategies.find((s) => s.execution === "E02")!;
    expect(e02.nearBust).toBe(true); // 310 against a loss limit of 300
    expect(r.data.breakersChecked).toBe(true);
    expect(r.data.nearPct).toBe(15);
  });

  it("flags the stress ladder safe / caution / bust per strategy against its own loss limit", async () => {
    const r = await loadRisk({ mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW });
    expect(r.data.stress).toEqual([
      expect.objectContaining({ pct: -30, flag: "bust", affected: 1 }),
      expect.objectContaining({ pct: -10, flag: "caution", affected: 1 }),
    ]);
    expect(r.data.stress.find((s) => s.pct === -10)?.pnl.micro).toBe(-12_340_000 - 5_000_000);
  });

  it("lists every strategy and family with its own and its effective state", async () => {
    const r = await loadRisk({ mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW });
    expect(r.data.executions.map((e) => [e.key, e.state, e.effective])).toEqual([
      ["E01", "enabled", "enabled"],
      ["E02", "enabled", "paused"], // family F2 is paused
    ]);
    expect(r.data.families.find((f) => f.key === "F2")).toMatchObject({
      state: "paused",
      effective: "paused",
    });
    expect(r.data.families).toHaveLength(6);
  });

  it("a position's status is 'unknown' (never green) when no breaker check exists for the day", async () => {
    const other = await emptyDbs();
    await seedPopulated(other);
    await other.main.execute("DROP TRIGGER IF EXISTS thesis_breaker_eval_no_delete");
    await other.main.execute("DELETE FROM thesis_breaker_eval");
    const r = await loadRisk({ mainDb: other.main, authDb: other.auth, user: OWNER, now: NOW });
    expect(r.data.breakersChecked).toBe(false);
    expect(r.data.strategies.find((s) => s.execution === "E01")!.positions[0]!.breaker).toBe(
      "unknown",
    );
  });

  it("masked: the loader result carries no code, name or stored id", async () => {
    for (const u of [EDITOR, VIEWER, null]) {
      const r = await loadRisk({ mainDb: db.main, authDb: db.auth, user: u, now: NOW });
      expect(r.masked).toBe(true);
      expect(leaks(r)).toEqual([]);
      expect(r.data.strategies[0]!.positions.every((p) => p.value === null)).toBe(true);
    }
  });
});

// ---- Risk page --------------------------------------------------------------------------------

describe("Risk overview page", () => {
  it("asks for the read action first and shows the Owner the real code and the controls", async () => {
    as(OWNER);
    const html = await risk();
    expect(requireUser).toHaveBeenCalledWith("read", "/strategies/risk");
    expect(html).toContain("<h1");
    expect(html).toContain("Risk overview");
    expect(html).toContain("ZZUP");
    expect(html).toContain("Distance to bust");
    expect(html).toContain("Owner controls");
    expect(html).toContain("Pause new entries");
    expect(html).toContain("Switch off");
    expect(html).toContain("Switch back on"); // F2 is paused/off: lifting is offered
    expect(html).toContain("Stress test");
    expect(html).toContain("Would reach the loss limit");
    expect(html).toContain("Caution: close to the loss limit");
    expect(html).toContain("Simulated");
    expect(html).not.toMatch(/liquidat/i); // UXN-150: never the word "liquidation"
  });

  it("an Editor sees letters, the controls disabled with the reason, and no code", async () => {
    as(EDITOR);
    const html = await risk();
    expect(html).toContain("Stock C");
    expect(html).toContain("Only the Owner can pause or switch off a strategy.");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Confirm");
    expect(leaks(html)).toEqual([]);
  });

  it("a Viewer sees the status but not the controls, and no code", async () => {
    as(VIEWER);
    const html = await risk();
    expect(html).toContain("Pause and switch-off");
    expect(html).not.toContain("Owner controls");
    expect(html).not.toContain("Pause new entries");
    expect(leaks(html)).toEqual([]);
  });

  it("the guard refusal stops the page before any data is read", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(RiskPage()).rejects.toThrow(/REDIRECT/);
    expect(mem.reads).toBe(0);
  });

  it("empty (data-only production): a defined empty state, controls still listed, no invented rows", async () => {
    const e = await emptyDbs();
    mem.main = e.main;
    mem.auth = e.auth;
    as(OWNER);
    const html = await risk();
    expect(html).toContain("No positions yet");
    expect(html).toContain("No stress test yet");
    expect(html).toContain("Every strategy is running.");
  });
});

// ---- Ideas ------------------------------------------------------------------------------------

describe("Tonight's trade ideas (UX-040, UXN-126)", () => {
  it("tallies the closed trades per family: 50 closed, 40 inside their 10th to 90th range", async () => {
    const v = await loadIdeas({ mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW });
    expect(v.data.familyTally).toEqual([
      expect.objectContaining({
        family: "F1",
        closed: 50,
        inside: 40,
        insidePct: 80,
        early: false,
      }),
    ]);
    // open rows and rows without a card range are not counted
    await ledger("L-open", SIG_UP, null);
    const again = await loadIdeas({ mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW });
    expect(again.data.familyTally[0]!.closed).toBe(50);
  });

  it("the Owner page: groups, taken / not taken with reason, card links, the tally sentence", async () => {
    as(OWNER);
    const html = await ideas();
    expect(requireUser).toHaveBeenCalledWith("read", "/strategies/ideas");
    expect(html).toContain("Tonight&#x27;s trade ideas");
    expect(html).toContain("ZZUP");
    expect(html).toContain("3 ideas found: 1 taken, 1 not taken.");
    expect(html).toContain("not taken: ZZOTH is held");
    expect(html).toContain(encodeURIComponent(CARD_UP));
    expect(html).toContain(
      "80% of 50 closed trades landed inside the 10th to 90th range (about 80% expected if the ranges are honest).",
    );
    expect(html).not.toContain("<button"); // nothing places an order
  });

  it.each([
    ["Editor", EDITOR],
    ["Viewer", VIEWER],
  ])("%s: letters, opaque card links, no code, name, stored id or link", async (_n, u) => {
    as(u);
    const html = await ideas();
    expect(html).toContain("Stock C");
    expect(html).toContain(encodeURIComponent(cardRef(CARD_UP)));
    expect(leaks(html)).toEqual([]);
  });
});

// ---- Decision Card ----------------------------------------------------------------------------

describe("Decision Card page (UXN-037, 100, 102, 104, 120 to 123, 126)", () => {
  it("loader: factors from the stored buckets, and the 'not enough history' bucket has no bar", async () => {
    const p = await loadCardPage(
      { mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW },
      CARD_UP,
    );
    // the seed card's only rule is "R1 vs ZZDN": no factor row matches it, so the factor list is empty
    expect(p.data.factors).toEqual({ up: [], down: [], notEnough: [] });
    expect(p.data.checklist).toHaveLength(1);
    expect(p.data.validation).toBe("UNVALIDATED");
    expect(p.data.past?.caveat).toContain("Based on past test data only");
    expect(p.data.afterwards?.state).toBe("closed");
    expect(p.data.afterwards?.text).toContain("inside the usual range"); // first ledger row: +1 %
    expect(p.data.why.join(" ")).not.toMatch(/\bwill\b/);
  });

  it("the Owner page has every section, in order, and the note form", async () => {
    as(OWNER);
    const html = await card(encodeURIComponent(CARD_UP));
    const order = [
      "Based on",
      "Thesis",
      "What past similar setups did",
      "What pushes it up and what pulls it down",
      "Rules that fired",
      "Warning signs",
      "What could hurt this",
      "Exit plan",
      "Size and cost",
      "Scenario",
      "Afterwards: how did it turn out?",
      "Why?",
      "Notes",
    ];
    let at = -1;
    for (const h of order) {
      const i = html.indexOf(`>${h}</h2>`);
      expect(i, h).toBeGreaterThan(at);
      at = i;
    }
    expect(html).toContain("This strategy is not proven yet");
    expect(html).toContain("Rules-only (AI unavailable today)");
    expect(html).toContain("Historical range, not a forecast");
    expect(html).toContain("Bad case");
    expect(html).toContain("<details"); // the scenario table is collapsed behind a tap
    expect(html).toContain("ZZUP looks cheap to me.");
    expect(html).toContain("Save note");
    expect(html).not.toMatch(/buy now|sell now|place order/i);
  });

  it("a Viewer addressing the opaque reference: no code, id or note text; 'Note added by' only", async () => {
    as(VIEWER);
    const html = await card(encodeURIComponent(cardRef(CARD_UP)));
    expect(html).toContain("Note added by editor on 2026-10-19");
    expect(html).not.toContain("looks cheap");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("news</a>"); // company news is hidden when masked
    expect(leaks(html)).toEqual([]);
  });

  it("an Editor (masked) can write a note, but the form carries only the reference", async () => {
    as(EDITOR);
    const html = await card(encodeURIComponent(cardRef(CARD_UP)));
    expect(html).toContain("Save note");
    expect(html).toContain("Your access hides stock names");
    expect(leaks(html)).toEqual([]);
  });

  it("a real id from a masked user 404s exactly like an unknown id", async () => {
    as(VIEWER);
    const a = await card(encodeURIComponent(CARD_UP)).catch((e: Error) => e.message);
    const b = await card(encodeURIComponent("card:sig:none:E01")).catch((e: Error) => e.message);
    expect(a).toBe(b);
    expect(a).toContain("404");
  });
});

describe("anonymous (no user): masked everywhere, and a real card id is not found", () => {
  it("loaders mask, and the card is reachable only through its opaque reference", async () => {
    const d = { mainDb: db.main, authDb: db.auth, user: null, now: NOW };
    expect(leaks(await loadIdeas(d))).toEqual([]);
    expect(leaks(await loadRisk(d))).toEqual([]);
    expect((await loadCardPage(d, CARD_UP)).data.found).toBe(false);
    const viaRef = await loadCardPage(d, cardRef(CARD_UP));
    expect(viaRef.data.found).toBe(true);
    expect(viaRef.masked).toBe(true);
    expect(leaks(viaRef)).toEqual([]);
    expect(viaRef.data.notes.every((n) => n.text === null)).toBe(true);
  });
});

// Last: the grant stays in the database for the rest of the file.
describe("an unmask grant", () => {
  it("an Editor with a live grant sees the real code on the Risk page, with the controls still disabled", async () => {
    await db.auth.execute({
      sql: `INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at)
            VALUES (?, ?, '2026-10-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      args: [EDITOR.id, OWNER.id],
    });
    as(EDITOR);
    const html = await risk();
    expect(html).toContain("ZZUP");
    expect(html).toContain("Only the Owner can pause or switch off a strategy.");
    expect(await card(encodeURIComponent(CARD_UP))).toContain("looks cheap");
  });
});

void COHORT_E01;
