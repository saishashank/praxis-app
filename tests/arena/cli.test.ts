// @vitest-environment node
// The close-books and replay command lines (M3 T10): configuration errors, the replay-only-on-a-file
// rule (D-066), the data-only skip, waiting for Batch 1's marker, catching up missed sessions,
// counts-only output (no URL, token or driver text) and the step output file.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { closeBooksMain, replayMain } from "@/lib/arena/cli";
import { toBig } from "@/lib/arena/ledgerWriter";
import { cleanupTempDbs, track } from "../db/helpers";
import { dbUrlOf, setMode, setupReplay, type FullSetup } from "./replayHarness";

/**
 * D-711: the CLI is the live entry point (no --replay), so it gates on the strict calendar rule: a
 * weekday needs a calendar row. The harness seeds holidays and early closes only, so give the other
 * synthetic weekdays the session rows the production seed carries.
 */
async function sessionRows(s: FullSetup): Promise<void> {
  for (const d of s.ds.dates) {
    await s.db.execute({
      sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('AU', ?, 'session', NULL, 1, 'synthetic')",
      args: [d],
    });
  }
}

afterEach(cleanupTempDbs);

const SECRET_URL = "libsql://praxis-secret-host.turso.io";
const SECRET_TOKEN = "eyJ-SECRET-TOKEN-do-not-print";
const SMALL = { startD: "2030-01-07", sessions: 30, seed: 9 };

function harness(
  s: FullSetup,
  extra: { nowMs?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const lines: string[] = [];
  const deps = {
    openDb: () => track(createClient({ url: dbUrlOf(s.db), intMode: "bigint" })) as Client,
    nowMs: extra.nowMs ?? (() => Date.parse("2030-02-20T06:00:00.000Z")),
    sleep: extra.sleep ?? (async () => undefined),
    out: (l: string) => lines.push(l),
  };
  return { deps, lines };
}

const nav = async (db: Client, d: string): Promise<bigint> =>
  toBig(
    (await db.execute({ sql: "SELECT COUNT(*) AS n FROM nav_daily WHERE d = ?", args: [d] }))
      .rows[0].n,
  );

describe("close-books command line", () => {
  it("fails without a configured database and refuses --replay against a remote database", async () => {
    const lines: string[] = [];
    const deps = { out: (l: string) => lines.push(l) };
    expect(await closeBooksMain([], {}, deps)).toBe(1);
    expect(await closeBooksMain([], { TURSO_MAIN_URL: SECRET_URL }, deps)).toBe(1);
    expect(
      await closeBooksMain(
        ["--replay"],
        { TURSO_MAIN_URL: SECRET_URL, TURSO_MAIN_TOKEN: SECRET_TOKEN },
        deps,
      ),
    ).toBe(2);
    expect(lines.join("\n")).not.toMatch(/secret/i);
  });

  it("production with a data_only market records a skip, exits 0 and prints no secret", async () => {
    const s = await setupReplay(SMALL);
    const h = harness(s);
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-out-"));
    const outFile = path.join(dir, "out.txt");
    const code = await closeBooksMain(
      ["--date", s.ds.dates[5]],
      { TURSO_MAIN_URL: SECRET_URL, TURSO_MAIN_TOKEN: SECRET_TOKEN, GITHUB_OUTPUT: outFile },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("skipped (data_only_guard)");
    expect(h.lines.join("\n")).not.toMatch(/secret/i);
    expect(readFileSync(outFile, "utf8")).toBe("status=skipped\n");
    expect(await nav(s.db, s.ds.dates[5])).toBe(0n);
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes the session when the market is full; a second run says already_done", async () => {
    const s = await setupReplay(SMALL);
    await setMode(s.db, "full");
    await sessionRows(s);
    const h = harness(s);
    const env = {
      TURSO_MAIN_URL: SECRET_URL,
      TURSO_MAIN_TOKEN: SECRET_TOKEN,
      COMMIT_SHA: "c".repeat(40),
    };
    expect(await closeBooksMain(["--date", s.ds.dates[5]], env, h.deps)).toBe(0);
    expect(h.lines[0]).toContain(`${s.ds.dates[5]}: success`);
    expect(await nav(s.db, s.ds.dates[5])).toBe(BigInt(s.cohortIds.length));
    const sha = await s.db.execute("SELECT commit_sha FROM run_record WHERE status = 'success'");
    expect(String(sha.rows[0].commit_sha)).toBe("c".repeat(40));
    expect(await closeBooksMain(["--date", s.ds.dates[5]], env, h.deps)).toBe(0);
    expect(h.lines[1]).toContain("already_done");
  });

  it("waits for Batch 1's marker: appears during the wait -> closes; never appears -> exit 1", async () => {
    const s = await setupReplay({ ...SMALL, stopAfter: 10 });
    await setMode(s.db, "full");
    await sessionRows(s);
    const d = s.ds.dates[15];
    let clock = Date.parse("2030-02-20T06:00:00.000Z");
    let sleeps = 0;
    let inserted = false;
    const h = harness(s, {
      nowMs: () => clock,
      sleep: async (ms) => {
        clock += ms;
        sleeps += 1;
        if (sleeps === 3 && !inserted) {
          inserted = true;
          await s.db.execute({
            sql: `INSERT INTO completion_marker (market, d, kind, at, run_id, outcome)
                  VALUES ('AU', ?, 'data', '2030-02-20T06:00:00.000Z', 1, 'ok')`,
            args: [d],
          });
        }
      },
    });
    const env = { TURSO_MAIN_URL: SECRET_URL, TURSO_MAIN_TOKEN: SECRET_TOKEN };
    expect(await closeBooksMain(["--date", d, "--wait-minutes", "10"], env, h.deps)).toBe(0);
    expect(sleeps).toBe(3);
    expect(h.lines.at(-1)).toContain(`${d}: success`);

    const late = s.ds.dates[16];
    sleeps = 0;
    expect(await closeBooksMain(["--date", late, "--wait-minutes", "2"], env, h.deps)).toBe(1);
    expect(sleeps).toBeGreaterThanOrEqual(3); // polled for the whole wait, then gave up
    expect(h.lines.at(-1)).toContain("no_completion_marker");
    expect(await nav(s.db, late)).toBe(0n);
  });

  it("catches up the sessions missed since the last success, oldest first", async () => {
    const s = await setupReplay(SMALL);
    await setMode(s.db, "full");
    await sessionRows(s);
    const h = harness(s);
    const env = { TURSO_MAIN_URL: SECRET_URL, TURSO_MAIN_TOKEN: SECRET_TOKEN };
    expect(await closeBooksMain(["--date", s.ds.dates[3]], env, h.deps)).toBe(0);
    expect(await closeBooksMain(["--date", s.ds.dates[7]], env, h.deps)).toBe(0);
    const days = h.lines.slice(1).map((l) => l.split(" ")[2]);
    expect(days).toEqual(s.ds.dates.slice(4, 8).map((d) => `${d}:`));
    for (let i = 3; i <= 7; i++) expect(await nav(s.db, s.ds.dates[i])).toBeGreaterThan(0n);
  });

  it("a failed close exits 1 and stops", async () => {
    const s = await setupReplay({ ...SMALL, keep: ["E01"] });
    await setMode(s.db, "full");
    await sessionRows(s);
    const h = harness(s);
    const env = { TURSO_MAIN_URL: SECRET_URL, TURSO_MAIN_TOKEN: SECRET_TOKEN };
    expect(await closeBooksMain(["--date", s.ds.dates[3]], env, h.deps)).toBe(0);
    await s.db.execute({
      sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
            VALUES (?, ?, 'tamper', 'cash_settled', 1000000, 'div_pay')`,
      args: [s.cohortIds[0], s.ds.dates[3]],
    });
    expect(await closeBooksMain(["--date", s.ds.dates[4]], env, h.deps)).toBe(1);
    expect(h.lines.at(-1)).toContain("failed (invariants_failed)");
  });

  it("never prints a driver error", async () => {
    const lines: string[] = [];
    const code = await closeBooksMain(
      ["--date", "2030-02-04"],
      { TURSO_MAIN_URL: SECRET_URL, TURSO_MAIN_TOKEN: SECRET_TOKEN },
      {
        openDb: () => {
          throw new Error(`connect failed ${SECRET_URL}`);
        },
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toMatch(/secret/i);
  });
});

describe("replay command line", () => {
  it("refuses anything but a local file database", async () => {
    const lines: string[] = [];
    const deps = { out: (l: string) => lines.push(l) };
    expect(
      await replayMain(
        ["--db", SECRET_URL, "--from", "2030-01-07", "--to", "2030-01-31"],
        {},
        deps,
      ),
    ).toBe(2);
    expect(await replayMain([], {}, deps)).toBe(2);
    expect(lines.join("\n")).not.toMatch(/secret/i);
  });

  it("replays a range into the file and reports counts", async () => {
    const s = await setupReplay(SMALL);
    const h = harness(s);
    const code = await replayMain(
      ["--db", dbUrlOf(s.db), "--from", s.ds.dates[0], "--to", s.ds.dates[9]],
      {},
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.lines[0]).toMatch(/sessions=10 success=10$/);
    expect(await nav(s.db, s.ds.dates[9])).toBe(BigInt(s.cohortIds.length));
  });
});
