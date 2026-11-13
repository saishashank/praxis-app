// @vitest-environment node
// AT-68 (M19 E2, MKT-110, D-994 to D-997, D-1079; runs in the `app` job of every CI run): with only AU enabled
// (the production shape, the seed) nothing of IN or US can happen. Three clauses, each proven on the real code:
//   (a) no job: the Worker builds AU slots only (the clock and `runNow` refusing IN are worker/test/at68Worker.test.ts,
//       the same CI run); every writing script refuses `--market IN`
//       with exit 2 and no run record; the workflows pass their `market` input through;
//   (b) no rows: a planted `price_bar` insert for IN throws `MarketNotEnabled` and raises the incident; the nightly
//       invariant counts 0 IN/US rows and alarms on a planted one;
//   (c) no UI: `envFor` 404s `?market=IN`, the switcher lists the enabled markets only, the Owner's Markets row reads
//       "Built — off in production", an Editor or a Viewer never sees a built-off row, and the e2e `leaks()` helper
//       finds what it is meant to find (the walk itself is e2e/market-off.spec.ts).
// The production-shape assertion on the recorded day's database is scripts/e2e-day/assert-production-shape.mjs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
// @ts-expect-error js-yaml is untyped in this package
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketRefusalReporter, resetMarketRefusalReports } from "@/lib/db/client";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { checkMarketRows, countRowsByMarket } from "@/lib/maintenance/rowsByMarket";
import { MarketNotEnabled, wrapClient } from "@/lib/market/guard.mjs";
import { enabledMarkets } from "@/lib/market/profile";
import { loadSettings } from "@/lib/ui/loaders/settings";
import { marketRows, readProfiles } from "@/app/(app)/settings/region";
import { parseMarketRows } from "../../../worker/src/markets";
import { slotTable } from "../../../worker/src/schedule";
import { AU_ROW, IN_ROW } from "../../../worker/test/auRow";
import { marketLeaks, withoutMarketsTable } from "../../../e2e/support/leaks";
// @ts-expect-error plain .mjs without types
import { run as batch1 } from "../../../scripts/ingest/batch1.mjs";
// @ts-expect-error plain .mjs without types
import { run as historyBackfill } from "../../../scripts/backfill/run.mjs";
// @ts-expect-error plain .mjs without types
import { run as priceBackfill } from "../../../scripts/backfill/prices.mjs";
// @ts-expect-error plain .mjs without types
import { run as indexBackfill } from "../../../scripts/backfill/index.mjs";
import { run as calendarDraft } from "../../../scripts/calendar/draft.mjs";
// @ts-expect-error plain .mjs without types
import { run as closeBooks } from "../../../scripts/arena/close-books.mjs";
// @ts-expect-error plain .mjs without types
import { run as signals } from "../../../scripts/arena/signals.mjs";
import {
  cleanupTempDbs,
  freshDb,
  MIGRATIONS,
  plantOffMarketRow,
  tempDbUrl,
  track,
} from "../../db/helpers";

const holder = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/db/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/client")>()),
  mainDb: () => holder.main,
  authDb: () => holder.auth,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
import { envFor, loadShell } from "@/lib/ui/loaders/shell";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, "worker/test/fixtures/au-slots.snapshot.json"), "utf8"),
) as { slots: { id: string }[] };

afterEach(() => {
  cleanupTempDbs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
describe("AT-68 (a): no job for a market that is not enabled", () => {
  it("the Worker builds the AU slot table from the enabled rows only; IN and US name no slot", () => {
    const table = slotTable([AU_ROW]);
    expect(table.skipped).toEqual([]);
    expect(table.slots.map((s) => s.id)).toEqual(FIXTURE.slots.map((s) => s.id)); // the recorded AU table
    const text = JSON.stringify(table.slots);
    expect(text).not.toMatch(/:(IN|US)[:"]/);
    expect(table.slots.some((s) => s.market !== undefined)).toBe(false); // one market: untagged
    // the per-tick read keeps the rows with enabled = 1: a built-off IN row never reaches the table
    const parsed = parseMarketRows([
      ["IN", IN_ROW.tz, "09:15", "15:30", "17:30", "INR", "off", 0, IN_ROW.slots_json],
    ]);
    expect(parsed).toEqual([]);
    expect(slotTable(parsed).slots).toEqual([]);
  });

  // ---- every writing script: --market IN is refused, exit 2, no run record -------------------------------------
  async function scratch() {
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-at68-"));
    const url = pathToFileURL(path.join(dir, "main.db")).href;
    const db = createClient({ url });
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const lines: string[] = [];
    const runRecords = async () =>
      Number((await db.execute("SELECT COUNT(*) AS n FROM run_record")).rows[0]!.n);
    const writes = async () =>
      Number(
        (
          await db.execute(
            "SELECT (SELECT COUNT(*) FROM price_bar) + (SELECT COUNT(*) FROM trading_calendar WHERE market <> 'AU') AS n",
          )
        ).rows[0]!.n,
      );
    const cleanup = () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows keeps the file locked for a moment */
      }
    };
    return { dir, url, db, lines, runRecords, writes, cleanup, out: (s: string) => lines.push(s) };
  }
  const NOW = Date.parse("2026-10-13T06:30:00.000Z");

  it("batch 1, the three backfills and the calendar draft refuse --market IN: exit 2, the fixed line, no run record, no write", async () => {
    const t = await scratch();
    try {
      const env = {
        TURSO_MAIN_URL: t.url,
        TURSO_MAIN_TOKEN: "unused-for-file",
        COMMIT_SHA: "c".repeat(40),
      };
      const deps = {
        openDb: (u: string) => createClient({ url: u }),
        nowMs: () => NOW,
        out: t.out,
      };
      writeFileSync(path.join(t.dir, "index.json"), "[]");
      const cases: [string, () => Promise<number>][] = [
        [
          "batch1 prepare",
          () =>
            batch1(
              ["prepare", "--market", "IN", "--request", path.join(t.dir, "r.json")],
              env,
              deps,
            ),
        ],
        [
          "batch1 run",
          () => batch1(["run", "--market", "IN", "--bars", path.join(t.dir, "b.json")], env, deps),
        ],
        [
          "history plan",
          () =>
            historyBackfill(
              ["plan", "--market", "IN", "--out", path.join(t.dir, "p.json")],
              env,
              deps,
            ),
        ],
        [
          "price plan",
          () =>
            priceBackfill(
              ["plan", "--market", "US", "--out", path.join(t.dir, "q.json")],
              env,
              deps,
            ),
        ],
        [
          "index commit",
          () =>
            indexBackfill(
              [
                "commit",
                "--market",
                "IN",
                "--index",
                path.join(t.dir, "index.json"),
                "--from",
                "2026-10-01",
                "--to",
                "2026-10-13",
              ],
              env,
              deps,
            ),
        ],
        [
          "calendar draft",
          () =>
            calendarDraft(
              ["--market", "IN", "--year", "2027", "--now", "2026-11-01T00:00:00Z"],
              env,
              t.out,
              { connect: async () => createClient({ url: t.url }) },
            ),
        ],
      ];
      for (const [name, call] of cases) {
        t.lines.length = 0;
        expect(await call(), name).toBe(2);
        expect(t.lines.join("\n"), name).toMatch(/refused: market not enabled/);
        expect(await t.runRecords(), name).toBe(0);
      }
      expect(await t.writes()).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it("close-books (2a) and signals (2b) refuse --market IN: exit 2, no run record", async () => {
    const t = await scratch();
    try {
      const env = { TURSO_MAIN_URL: t.url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" };
      const deps = { nowMs: () => Date.parse("2026-10-13T08:00:00.000Z"), out: t.out };
      expect(await closeBooks(["--date", "2026-10-13", "--market", "IN"], env, deps)).toBe(2);
      expect(await signals(["--date", "2026-10-13", "--market", "US"], env, deps)).toBe(2);
      expect(t.lines).toEqual([
        "arena-2a: refused: market not enabled",
        "arena-2b: refused: market not enabled",
      ]);
      expect(t.lines.join("\n")).not.toMatch(/secret|file:/);
      expect(await t.runRecords()).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  // ---- the dispatching workflows pass the market input to the script -------------------------------------------
  const WORKFLOWS: Record<string, string[]> = {
    "ingest-batch1": ["batch1.mjs prepare", "batch1.mjs run"],
    "arena-close": ["close-books.mjs"],
    "arena-signals": ["signals.mjs"],
    replay: ["replay/run.mjs"],
    "backfill-history": ["backfill/run.mjs plan", "backfill/run.mjs commit"],
    "backfill-prices": ["backfill/prices.mjs plan", "backfill/prices.mjs commit"],
    "backfill-index": ["backfill/index.mjs commit"],
    "calendar-draft": [],
  };
  for (const [name, scripts] of Object.entries(WORKFLOWS)) {
    it(`workflow ${name}: a market input (default empty) reaches the script`, () => {
      const wf = yaml.load(
        readFileSync(path.join(ROOT, ".github/workflows", `${name}.yml`), "utf8"),
      ) as {
        on: {
          workflow_dispatch: {
            inputs: Record<string, { type?: string; default?: string; required?: boolean }>;
          };
        };
        jobs: { production: { steps: { run?: string; env?: Record<string, string> }[] } };
      };
      const input = wf.on.workflow_dispatch.inputs.market!;
      expect(input, name).toBeDefined();
      expect(input.default ?? "").toBe("");
      expect(input.required ?? false).toBe(false);
      for (const frag of scripts) {
        const step = wf.jobs.production.steps.find(
          (s) => typeof s.run === "string" && s.run.includes(frag),
        );
        expect(step, frag).toBeDefined();
        expect(step!.run).toContain('${MARKET_INPUT:+--market "$MARKET_INPUT"}');
        expect(step!.env?.MARKET_INPUT).toBe("${{ inputs.market }}");
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
describe("AT-68 (b): no rows for a market that is not enabled", () => {
  let raw: Client;
  beforeEach(async () => {
    resetMarketRefusalReports();
    raw = track(createClient({ url: tempDbUrl() }));
    await migrateUp(raw, await loadMigrations(MIGRATIONS("main")));
  });

  const bar = (market: string, code = "AAA") => ({
    sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
          VALUES (?, ?, '2026-11-11', 1, 1, 1, 1, 1, 't', 't', 't')`,
    args: [market, code],
  });

  it("a planted price_bar insert for IN throws MarketNotEnabled and raises the incident once; AU passes", async () => {
    // the database itself refuses (the trigger), with the fixed text
    await expect(raw.execute(bar("IN"))).rejects.toThrow(/MarketNotEnabled price_bar/);
    await expect(
      raw.execute({ ...bar("US"), sql: bar("US").sql.replace("INSERT", "INSERT OR IGNORE") }),
    ).rejects.toThrow(/MarketNotEnabled price_bar/);
    // the application client maps it to the typed error and reports it (S2, once per market per day)
    const c = wrapClient(raw, marketRefusalReporter(raw));
    await expect(c.execute(bar("IN"))).rejects.toBeInstanceOf(MarketNotEnabled);
    await c.execute(bar("IN", "BBB")).catch(() => undefined);
    const incidents = (await raw.execute("SELECT severity, kind FROM incident")).rows;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ severity: "S2", kind: "market_not_enabled" });
    await c.execute(bar("AU"));
    expect(Number((await raw.execute("SELECT COUNT(*) AS n FROM price_bar")).rows[0]!.n)).toBe(1);
    expect(
      (await raw.execute("SELECT COUNT(*) AS n FROM price_bar WHERE market <> 'AU'")).rows[0]!.n,
    ).toBe(0);
  });

  it("the nightly invariant counts 0 IN/US rows under the seed and alarms on a planted one", async () => {
    await raw.execute(bar("AU"));
    const quiet = await checkMarketRows(raw, "2026-11-12", new Date("2026-11-12T00:30:00.000Z"));
    expect(quiet.unexpected).toEqual([]);
    expect(
      (await raw.execute("SELECT COUNT(*) AS n FROM market_row_count WHERE market IN ('IN', 'US')"))
        .rows[0]!.n,
    ).toBe(0);
    expect((await raw.execute("SELECT 1 FROM incident")).rows).toHaveLength(0);

    await plantOffMarketRow(raw, "price_bar", {
      market: "IN",
      code: "AAA",
      d: "2026-11-11",
      o: 1,
      h: 1,
      l: 1,
      c: 1,
      volume: 1,
      source: "t",
      published_at: "t",
      ingested_at: "t",
    });
    expect((await countRowsByMarket(raw)).unexpected.map((u) => [u.tbl, u.market, u.n])).toEqual([
      ["price_bar", "IN", 1],
    ]);
    const alarmed = await checkMarketRows(raw, "2026-11-12", new Date("2026-11-12T00:30:00.000Z"));
    expect(alarmed.unexpected).toHaveLength(1);
    const inc = (
      await raw.execute("SELECT severity, kind FROM incident WHERE kind = 'market_rows_unexpected'")
    ).rows;
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2" });
    // the enabled set equals the production default: no markets_enabled_mismatch
    expect(
      (await raw.execute("SELECT 1 FROM incident WHERE kind = 'markets_enabled_mismatch'")).rows,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("AT-68 (c): no UI for a market that is not enabled", () => {
  let main: Client;
  let auth: Client;
  beforeEach(async () => {
    main = await freshDb("main");
    auth = await freshDb("auth");
    holder.main = main;
    holder.auth = auth;
  });
  const owner = { id: 1, role: "owner" };
  const settingsFor = async (role: string) => {
    const model = await loadSettings({ main, auth, user: { id: 1, role } } as never);
    return marketRows(model, await readProfiles(main), new Set(), role === "owner", "2026-11-12");
  };

  it("envFor is the one resolver: ?market=IN, US and an unknown code are 404, none and AU resolve to AU", async () => {
    for (const bad of ["IN", "US", "XX", ["AU", "IN"]]) {
      await expect(envFor(owner, undefined, bad), String(bad)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(await envFor(owner)).toMatchObject({ market: "AU" });
    expect(await envFor(owner, undefined, "AU")).toMatchObject({ market: "AU" });
  });

  it("the switcher lists the enabled markets only: AU under the seed; IN joins only when it is enabled", async () => {
    expect(await enabledMarkets(main)).toEqual(["AU"]);
    expect((await loadShell(await envFor(owner))).markets.map((m) => m.code)).toEqual(["AU"]);
    await main.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    const { invalidateProfiles } = await import("@/lib/market/profile");
    invalidateProfiles();
    expect((await loadShell(await envFor(owner))).markets.map((m) => m.code)).toEqual(["AU", "IN"]);
  });

  it("the Owner's Markets rows: AU active, IN and US 'Built — off in production' with the open gate items", async () => {
    const r = await settingsFor("owner");
    expect(r.map((x) => x.code)).toEqual(["AU", "IN", "US"]);
    expect(r.find((x) => x.code === "AU")).toMatchObject({ enabled: true });
    for (const code of ["IN", "US"]) {
      expect(r.find((x) => x.code === code)).toMatchObject({
        enabled: false,
        status: "built",
        statusText: "Built — off in production",
        evidence: "AT-M evidence: not recorded",
        gateItems: ["AU 60 trading days (MKT-105)", "Owner approval"],
        selectable: false,
      });
    }
  });

  it("an Editor and a Viewer never see a built-off row", async () => {
    for (const role of ["editor", "viewer"]) {
      const r = await settingsFor(role);
      expect(
        r.map((x) => x.code),
        role,
      ).toEqual(["AU"]);
      expect(
        r.some((x) => x.status === "built"),
        role,
      ).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/Built|"IN"|"US"|NSE|NYSE/);
    }
  });

  it("the e2e leaks() helper finds a built-off market in markup and words, and ignores the Owner's Markets table", () => {
    expect(marketLeaks('<li data-market="IN">x</li>')).toEqual(['data-market="IN"']);
    expect(marketLeaks('{"data-market":"US"}')).toEqual(['data-market="US"']);
    expect(marketLeaks("<p>Listed on the NSE in Kolkata, priced in ₹ or US$</p>").sort()).toEqual(
      ["Kolkata", "NSE", "US$", "₹"].sort(),
    );
    expect(
      marketLeaks(
        '<div data-market="AU"><p>Listed on the ASX in Sydney. LIST of ISTANBUL.</p></div>',
      ),
    ).toEqual([]);
    expect(marketLeaks("<script>var IST = 'India'; data-x</script><p>fine</p>")).toEqual([]);
    const page =
      '<main><div data-market="AU"></div><div data-markets-table><table><tr><td data-market="IN">IN</td></tr></table></div></main>';
    expect(marketLeaks(page)).toEqual(['data-market="IN"']);
    expect(marketLeaks(withoutMarketsTable(page))).toEqual([]);
    // every Owner Markets surface is cut (the Settings table and the Usage projection card, D-1196); text outside stays checked
    const two =
      '<main><section data-markets-table=""><div data-market="IN"></div></section><p>between</p><section data-markets-table=""><div data-market="US"><section>nested</section></div></section><p>NSE</p></main>';
    expect(marketLeaks(withoutMarketsTable(two))).toEqual(["NSE"]);
  });
});
