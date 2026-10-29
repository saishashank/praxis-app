// @vitest-environment node
// Replay snapshot builder (M4 T4, DAT-140, design 2.8): deterministic content sha, range filter,
// recent-window precedence, history files + database load. Synthetic data only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { gzipDeterministic, toJsonl } from "@/lib/data/backfill/rules.mjs";
import { loadInputs, monthsBetween } from "@/lib/data/backfill/snapshotLoad.mjs";
import { buildSnapshot, loadSnapshot, parseSnapshot, SnapshotError } from "@/lib/replay/snapshot";
import { backfillDb } from "../backfill/helpers";
import { seedAction, series, weekdays } from "../fixtures/replay/synthetic";

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

const days = weekdays("2026-09");
const calendar = days.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
const universe = days.flatMap((d) =>
  ["ZZA", "ZZB"].map((code) => ({
    d,
    code,
    status: "active",
    tier: "U1",
    mcap_est: 1e8,
    adv: 5e5,
    halted: 0,
  })),
);
const index_bars = days.map((d, i) => ({
  index_code: "AXJO",
  d,
  o_micro: 7_000_000_000 + i,
  h_micro: 7_000_000_100 + i,
  l_micro: 6_999_999_900 + i,
  c_micro: 7_000_000_050 + i,
}));
const corporate_actions = [
  { code: "ZZA", ex_date: "2026-09-15", action_id: 1, type: "split", factor: 0.5 },
];
const announcements = days.slice(0, 5).map((d, i) => ({
  code: "ZZA",
  ann_id: `a${i}`,
  published_at: `${d}T01:00:00.000Z`,
  type: "Synthetic",
  price_sensitive: i % 2,
  title: `Synthetic ${i}`,
}));
const bars = [...series("ZZA", days, 3, 500), ...series("ZZB", days, 1, 900)];

const inputs = () => ({ bars, calendar, universe, index_bars, corporate_actions, announcements });
const shuffled = <T>(a: T[]) =>
  [...a].reverse().sort((x, y) => (JSON.stringify(x).length % 3) - (JSON.stringify(y).length % 3));

describe("snapshot builder", () => {
  it("builds byte-identical output (same sha) from the same inputs in any row order", () => {
    const a = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: inputs() });
    const rev = Object.fromEntries(
      Object.entries(inputs()).map(([k, v]) => [k, shuffled(v as object[])]),
    );
    const b = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: rev });
    expect(b.sha).toBe(a.sha);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not read the clock or the random generator", () => {
    const now = vi.spyOn(Date, "now");
    const rnd = vi.spyOn(Math, "random");
    buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: inputs() });
    expect(now).not.toHaveBeenCalled();
    expect(rnd).not.toHaveBeenCalled();
    now.mockRestore();
    rnd.mockRestore();
  });

  it("any changed value or range changes the sha", () => {
    const a = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: inputs() });
    const changed = inputs();
    changed.bars = [{ ...bars[0], c: bars[0].c + 0.01 }, ...bars.slice(1)];
    expect(buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: changed }).sha).not.toBe(
      a.sha,
    );
    expect(buildSnapshot({ from: "2026-09-02", to: "2026-09-30", inputs: inputs() }).sha).not.toBe(
      a.sha,
    );
  });

  it("keeps only the range (corporate actions and index bars up to the end of it) and counts rows", () => {
    const s = buildSnapshot({ from: "2026-09-10", to: "2026-09-14", inputs: inputs() });
    expect(s.counts).toMatchObject({
      calendar: 3,
      bars: 6,
      universe: 6,
      index_bars: 10, // every index bar up to the end of the range: the regime warm-up (D-175)
      corporate_actions: 0,
    });
    const t = buildSnapshot({ from: "2026-09-10", to: "2026-09-30", inputs: inputs() });
    expect(t.counts.corporate_actions).toBe(1);
    const early = buildSnapshot({ from: "2026-09-16", to: "2026-09-30", inputs: inputs() });
    expect(early.counts.corporate_actions).toBe(1); // still needed to adjust a later view of the range
    // Sydney date of the publication decides the range (01:00Z is 11:00 or 12:00 Sydney, same day).
    expect(
      buildSnapshot({ from: "2026-09-01", to: "2026-09-01", inputs: inputs() }).counts
        .announcements,
    ).toBe(1);
  });

  it("recent database rows win over history rows with the same key", () => {
    const h = [{ ...bars[0] }];
    const recent = [{ ...bars[0], c: 99 }];
    const s = buildSnapshot({
      from: "2026-09-01",
      to: "2026-09-30",
      inputs: { bars: h, bars_recent: recent },
    });
    expect(parseSnapshot(s.bytes).tables.bars).toEqual([{ ...bars[0], c: 99 }]);
  });

  it("round-trips and the recomputed sha equals the recorded one", () => {
    const s = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: inputs() });
    const loaded = loadSnapshot(s.bytes);
    expect(loaded.sha).toBe(s.sha);
    expect(loaded.bars).toHaveLength(bars.length);
    expect(loaded.bars[0].code).toBe("ZZA");
    expect(loaded.corporateActions).toEqual(corporate_actions);
  });

  it("rejects malformed rows and ranges instead of repairing them", () => {
    expect(() => buildSnapshot({ from: "2026-09-30", to: "2026-09-01", inputs: {} })).toThrow(
      SnapshotError,
    );
    expect(() =>
      buildSnapshot({
        from: "2026-09-01",
        to: "2026-09-30",
        inputs: { bars: [{ ...bars[0], c: Number.NaN }] },
      }),
    ).toThrow(/bad_row:bars\.c/);
    expect(() =>
      buildSnapshot({
        from: "2026-09-01",
        to: "2026-09-30",
        inputs: { corporate_actions: [{ ...corporate_actions[0], factor: 0 }] },
      }),
    ).toThrow(SnapshotError);
  });

  it("an empty dataset is a valid, stable snapshot", () => {
    const a = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: {} });
    const b = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: {} });
    expect(a.sha).toBe(b.sha);
    expect(Object.values(a.counts).every((n) => n === 0)).toBe(true);
  });
});

describe("snapshot load (history files + database)", () => {
  async function seeded() {
    const db = await backfillDb();
    await db.batch(
      [
        ...days.slice(10).map((d) => ({
          sql: "INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at) VALUES ('AU', 'ZZA', ?, 5, 5.01, 4.99, 5, 700, 'yahoo', ?, ?)",
          args: [d, `${d}T06:30:00.000Z`, `${d}T07:00:00.000Z`],
        })),
        ...universe.slice(0, 4).map((u) => ({
          sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted) VALUES ('AU', ?, ?, 'active', 'U1', 1e8, 5e5, 0)",
          args: [u.d, u.code],
        })),
        ...index_bars.slice(0, 2).map((i) => ({
          sql: "INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at) VALUES ('AU', 'AXJO', ?, ?, ?, ?, ?, 'yahoo', ?, ?)",
          args: [
            i.d,
            i.o_micro,
            i.h_micro,
            i.l_micro,
            i.c_micro,
            `${i.d}T06:30:00.000Z`,
            `${i.d}T07:00:00.000Z`,
          ],
        })),
      ],
      "write",
    );
    await seedAction(db, { id: 1, code: "ZZA", type: "split", exDate: "2026-09-15", factor: 0.5 });
    const files = new Map<string, Uint8Array>([
      [
        "yahoo_prices-2026-09.jsonl.gz",
        gzipDeterministic(toJsonl(bars.filter((b) => b.d < days[10]))),
      ],
      [
        "asx_announcements-2026-09.jsonl.gz",
        gzipDeterministic(
          toJsonl(
            announcements.map((a) => ({ source: "asx_announcements", assumed_time: false, ...a })),
          ),
        ),
      ],
    ]);
    return { db, readAsset: (n: string) => files.get(n) ?? null };
  }

  it("lists months and loads old bars from files and recent bars from the database", async () => {
    expect(monthsBetween("2026-08-15", "2026-10-02")).toEqual(["2026-08", "2026-09", "2026-10"]);
    const { db, readAsset } = await seeded();
    const input = await loadInputs({
      db,
      readAsset,
      from: "2026-09-01",
      to: "2026-09-30",
      recentFrom: days[10],
    });
    expect(input.bars_recent).toHaveLength(days.length - 10);
    expect(input.bars).toHaveLength(20);
    expect(input.corporate_actions).toEqual([
      { code: "ZZA", ex_date: "2026-09-15", action_id: 1, type: "split", factor: 0.5 },
    ]);
    expect(input.announcements).toHaveLength(5);
    expect((input.calendar ?? []).length).toBeGreaterThan(0); // seeded by migration 0005
    const s = buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: input });
    expect(s.counts).toMatchObject({
      bars: days.length + 10,
      universe: 4,
      index_bars: 2,
      corporate_actions: 1,
    });
    // A second build from a fresh load is identical (stable ordering through the database).
    const again = buildSnapshot({
      from: "2026-09-01",
      to: "2026-09-30",
      inputs: await loadInputs({
        db,
        readAsset,
        from: "2026-09-01",
        to: "2026-09-30",
        recentFrom: days[10],
      }),
    });
    expect(again.sha).toBe(s.sha);
    // D-202: read in pages of 3 rows, the same rows and the same snapshot
    const paged = await loadInputs({
      db,
      readAsset,
      from: "2026-09-01",
      to: "2026-09-30",
      recentFrom: days[10],
      pageRows: 3,
    });
    expect(paged.bars_recent).toEqual(input.bars_recent);
    expect(buildSnapshot({ from: "2026-09-01", to: "2026-09-30", inputs: paged }).sha).toBe(s.sha);
  });

  it("the CLI writes the snapshot and its sha, twice the same", async () => {
    const { db, readAsset } = await seeded();
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-snap-"));
    tmp.push(dir);
    for (const [n] of [["yahoo_prices-2026-09.jsonl.gz"], ["asx_announcements-2026-09.jsonl.gz"]]) {
      writeFileSync(path.join(dir, n), readAsset(n)!);
    }
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(path.resolve("scripts/replay/snapshot.mjs")).href
    );
    const lines: string[] = [];
    const args = [
      "--from",
      "2026-09-01",
      "--to",
      "2026-09-30",
      "--history-dir",
      dir,
      "--recent-from",
      days[10],
    ];
    const env = { TURSO_MAIN_URL: "file:ignored" };
    const open = () =>
      new Proxy(db, {
        get: (t, k) => {
          if (k === "close") return () => undefined;
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    const o1 = path.join(dir, "o1");
    const o2 = path.join(dir, "o2");
    expect(
      await mod.run([...args, "--out", o1], env, {
        openDb: open,
        out: (s: string) => lines.push(s),
      }),
    ).toBe(0);
    expect(
      await mod.run([...args, "--out", o2], env, {
        openDb: open,
        out: (s: string) => lines.push(s),
      }),
    ).toBe(0);
    expect(readFileSync(path.join(o1, "snapshot.sha256"), "utf8")).toBe(
      readFileSync(path.join(o2, "snapshot.sha256"), "utf8"),
    );
    expect(
      readFileSync(path.join(o1, "snapshot.jsonl.gz")).equals(
        readFileSync(path.join(o2, "snapshot.jsonl.gz")),
      ),
    ).toBe(true);
    expect(lines[0]).toMatch(/^replay snapshot: ok sha=[0-9a-f]{64}/);
    expect(await mod.run(["--from", "x"], env, { out: (s: string) => lines.push(s) })).toBe(1);
  });
});
