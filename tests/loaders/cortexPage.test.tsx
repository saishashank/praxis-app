// Cortex page render (CTX-071, CTX-072, CTX-073, ROL-107, UX-009): the page component rendered from real
// temporary databases for the Owner and for a masked viewer, with an empty and a seeded world.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { emptyWorld, type Who, type World } from "./world";
import CortexPage from "@/app/(app)/cortex/page";

let current: World;
let who: Who = "owner";
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({
    id: current.ids[who],
    role: who === "granted" ? "viewer" : who,
  })),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => current.main, authDb: () => current.auth }));
vi.mock("next/navigation", () => ({ usePathname: () => "/cortex" }));

afterAll(cleanupTempDbs);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T23:00:00.000Z"));
});

const ISO = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;

async function seeded(): Promise<World> {
  const w = await emptyWorld();
  const run = (sql: string, args: (string | number | null)[] = []) => w.main.execute({ sql, args });
  await run(
    `INSERT INTO input_manifest (manifest_id, market, d, sources_json, schema_sha, row_counts_json, created_at)
     VALUES ('m1','AU','2026-10-16','{}','s','{}','2026-10-16T09:00:00Z')`,
  );
  await run(
    `INSERT INTO cortex_night (market, d, status, reason, manifest_id, universe_n, bars_n, feature_rows,
       runtime_ms, active_set_hash, map_fitted_at) VALUES ('AU','2026-10-16','ran',NULL,'m1',10,10,10,5,'h','2026-10-01T00:00:00Z')`,
  );
  await run(
    `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash, n_eff, pool, fit_split)
     VALUES ('AU','F1','v1','2026-10-01T00:00:00Z','{}','h',1,'p','development')`,
  );
  await run(
    `INSERT INTO angle_passport (market, angle_id, version, domain, cluster, orientation, kind, inputs_json,
       history_fields_json, status, horizon_sessions, evidence_json, measured_json, frozen_at)
     VALUES ('AU','zz_secret_angle',1,1,'momentum',1,'score','[]','{}','active',10,'{}',NULL,'2026-10-01T00:00:00Z')`,
  );
  await run(
    `INSERT INTO family_status (market, family, since_d, status, evidence_json, statement_id, set_by)
     VALUES ('AU','F1','2026-10-01','allowed','{"n_eff":212,"mde":0.012}',NULL,'import')`,
  );
  await run(
    `INSERT INTO cortex_statement (statement_id, market, family, kind, text, numbers_json, n_eff_live, created_at)
     VALUES ('st1','AU','F1','allowed_weak','Allowed on thin evidence so far.','{}',NULL,'2026-10-15T00:00:00Z')`,
  );
  for (const [id, kind, result] of [
    ["c1", "angle_ic", null],
    ["c2", "placebo", '{"passed":true,"null_pass_rate":0.04}'],
    ["c3", "nav_at_risk", '{"loss_95_pct":4.2,"loss_worst_pct":9.1}'],
    ["c4", "key_edit", null],
  ] as const) {
    await run(
      `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at, result_at,
         result_json, split, lineage_id) VALUES (?, 'AU', 'all', NULL, ?, '{}', '2026-10-01T00:00:00Z', ?, ?, 'development', NULL)`,
      [id, kind, result === null ? null : "2026-10-02T00:00:00Z", result],
    );
  }
  for (const b of ["B1", "B2"]) {
    await run(
      `INSERT INTO cortex_abstain (market, d, book_id, gate_id, label, detail_json)
       VALUES ('AU','2026-10-16',?,'G04_economic','setups like this have not come out ahead after costs','{}')`,
      [b],
    );
  }
  for (const [code, tilt] of [
    ["ZZUP", '{"sector":"Technology","tiltPp":2.5}'],
    ["ZZDN", '{"sector":"Materials","tiltPp":-1}'],
  ] as const) {
    await run(
      `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, gate_trace_json, sector_tilt_json, manifest_id)
       VALUES ('AU','2026-10-16','B1',?,'shadow','F7','[]',?,'m1')`,
      [code, tilt],
    );
  }
  await run(
    `INSERT INTO cortex_outcome (market, d, book_id, code, arm, fill_status, fill_micro, fill_d, net_micro, scored_at)
     VALUES ('AU','2026-10-16','B1','ZZUP','shadow','filled',10000000,'2026-10-16',5000000,'2026-10-17T00:00:00Z')`,
  );
  await run(
    `INSERT INTO opinion_track (market, opinion_id, kind, code, d, value_json, settled_d, outcome_json)
     VALUES ('AU','o1','steelman','ZZUP','2026-10-16','{}',NULL,NULL),
            ('AU','o2','steelman','ZZUP','2026-10-15','{}','2026-10-16','{}')`,
  );
  return w;
}

const show = async (w: World, as: Who) => {
  current = w;
  who = as;
  render(await CortexPage());
};
const section = (id: string) =>
  document.querySelector(`[data-cortex-section=${id}]`) as HTMLElement;
const q = (sel: string) => document.querySelector(sel)!;

describe("Cortex page, empty world", () => {
  it("shows the label, a shadow-only banner, the not-measured list and the Owner links", async () => {
    await show(await emptyWorld(), "owner");
    expect(screen.getByRole("heading", { level: 1, name: "Cortex" })).toBeInTheDocument();
    expect(
      screen.getByText(/Live books, matched settlement\. Every money figure is simulated\./),
    ).toBeInTheDocument();
    expect(q("[data-shadow-only]").textContent).toMatch(/shadow only/);
    expect(
      screen.getByText(/Warming up: 0 nights recorded and no map loaded yet\./),
    ).toBeInTheDocument();
    const missing = q("[data-cortex-unmeasured]");
    for (const m of [
      "Angles",
      "Ideas tried and luck",
      "Placebo check",
      "Value at risk",
      "Nights with no trade",
      "Sector tilt (shadow only)",
      "Opinion track",
    ])
      expect(missing.textContent).toContain(m);
    expect(section("passports")).toBeNull();
    expect(screen.queryByText(/Latest run/)).toBeNull();
    expect(
      within(section("families")).getAllByText("Shadow only (not trading)").length,
    ).toBeGreaterThanOrEqual(7);
    expect(within(section("families")).getAllByText(/Not measured yet/).length).toBeGreaterThan(0);
    expect(within(section("ticks")).getAllByText(/^A\$/).length).toBeGreaterThan(10);
    expect(q("[data-owner-controls]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Change a Cortex setting" })).toHaveAttribute(
      "href",
      "/config",
    );
    expect(screen.getByRole("link", { name: "Switch a strategy off or on" })).toHaveAttribute(
      "href",
      "/strategies/risk",
    );
  });

  it("shows a masked viewer no controls and numbered strategies", async () => {
    await show(await emptyWorld(), "viewer");
    expect(document.querySelector("[data-owner-controls]")).toBeNull();
    expect(screen.getByText("Only the Owner can change Cortex settings.")).toBeInTheDocument();
    expect(screen.getAllByText("Strategy 1").length).toBeGreaterThan(0);
  });
});

describe("Cortex page, seeded world", () => {
  it("shows the Owner names, figures, statements, tilt and opinions", async () => {
    await show(await seeded(), "owner");
    expect(screen.queryByText("Out of date")).toBeNull();
    expect(document.querySelector("[data-shadow-only]")).toBeNull();
    expect(within(section("passports")).getAllByText("zz_secret_angle")[0]).toBeInTheDocument();
    expect(section("passports").textContent).toContain("1 angles. 1 active.");
    expect(q("[data-luck]").textContent).toBe(
      "Of 4 ideas tried, about 0.4 would look good by luck alone.",
    );
    expect(section("ledger").textContent).toContain(
      "3 ideas tested so far; 1 Owner setting change also counted as tests.",
    );
    expect(within(section("families")).getAllByText("Follow the trend")[0]).toBeInTheDocument();
    expect(within(section("families")).getAllByText("Allowed to trade")[0]).toBeInTheDocument();
    expect(section("families").textContent).toContain("Allowed on thin evidence so far.");
    expect(q("[data-placebo]").textContent).toMatch(
      /Passed: a random look-alike passed about 4\.0% of the time\./,
    );
    expect(q("[data-nav-at-risk]").textContent).toMatch(/about 4\.2%.*worst day tested was 9\.1%/);
    expect(section("abstain").textContent).toContain(
      "2 strategy-nights without a trade in the last 60 days.",
    );
    expect(section("abstain").textContent).toContain(
      "setups like this have not come out ahead after costs",
    );
    expect(q("[data-comparator]").textContent).toMatch(/1 trades, .* after costs in total/);
    expect(section("sector").textContent).toContain("B1: Technology, +2.5 points");
    expect(section("sector").textContent).toContain("B1: Materials, -1 points");
    expect(section("opinion").textContent).toContain("steelman: 2 recorded, 1 settled");
    expect(q("[data-cold-start]").textContent).toMatch(/1 nights recorded since Fri 16 Oct./);
    expect(document.querySelector("[data-cortex-unmeasured]")).toBeNull();
    expect(screen.getByText(/Latest run:/)).toBeInTheDocument();
  });

  it("masks angles, strategies, books and exact dates for a viewer", async () => {
    await show(await seeded(), "viewer");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("zz_secret_angle");
    expect(text).not.toContain("Follow the trend");
    expect(text).not.toContain("Allowed on thin evidence");
    expect(text).not.toMatch(/\bB1\b/);
    expect(text).not.toMatch(ISO);
    expect(within(section("passports")).getAllByText("Angle 1")[0]).toBeInTheDocument();
    expect(section("sector").textContent).toContain("Book 1: Technology");
    expect(q("[data-comparator]").textContent).toMatch(/1 trades\./);
    expect(q("[data-comparator]").textContent).not.toContain("after costs");
    expect(q("[data-cold-start]").textContent).toContain("since week 2026-W42");
    expect(screen.getByText(/Latest run: week 2026-W42/)).toBeInTheDocument();
    expect(document.querySelector("[data-owner-controls]")).toBeNull();
  });

  it("says out of date when the newest night is old, and names only the week to a viewer", async () => {
    vi.setSystemTime(new Date("2026-11-20T00:00:00.000Z"));
    const w = await seeded();
    await show(w, "owner");
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    cleanup();
    await show(w, "viewer");
    const banner = screen.getByText("Out of date").parentElement!;
    expect(banner.textContent).toContain(
      "Showing data from week 2026-W42. It has not updated since.",
    );
    expect(banner.textContent).not.toMatch(ISO);
  });

  it("tells the Owner a setting was changed and the maps refit at the next run", async () => {
    const w = await seeded();
    await w.main.execute({
      sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at, result_at,
              result_json, split, lineage_id) VALUES ('c9','AU','all',NULL,'key_edit','{}','2026-10-10T00:00:00Z',NULL,NULL,'development',NULL)`,
      args: [],
    });
    await show(w, "owner");
    expect(screen.getByText("Refit waiting")).toBeInTheDocument();
    expect(screen.getByText(/maps are refitted at the next fitting run/)).toBeInTheDocument();
  });
});
