// @vitest-environment node
// D-1853: the manual rerun of a missed night (`arena-signals.yml` input `date` -> `--date D --rerun`).
// On 21 Nov 2026 batch 2b ran at 00:57 Sat Melbourne, keyed the session by the Saturday and skipped
// (non_trading_day), so Friday 20 Nov had no picks and the workflow had no way to name the date.
// A rerun may name only the latest session on or before today; an older one is refused before any
// write, because its orders would be filled after the fact.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { rerunRefusal, signalsMain } from "@/lib/arena/cli";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("rerunRefusal", () => {
  const none: Parameters<typeof rerunRefusal>[2] = [];

  it("allows Friday decided on the Saturday or the Sunday (no session in between)", () => {
    expect(rerunRefusal("2026-11-20", "2026-11-21", none)).toBeNull();
    expect(rerunRefusal("2026-11-20", "2026-11-22", none)).toBeNull();
  });

  it("allows today", () => {
    expect(rerunRefusal("2026-11-20", "2026-11-20", none)).toBeNull();
  });

  it("refuses Thursday once Friday has traded, and Friday once Monday has", () => {
    expect(rerunRefusal("2026-11-19", "2026-11-21", none)).toMatch(/not the latest session/);
    expect(rerunRefusal("2026-11-20", "2026-11-23", none)).toMatch(/not the latest session/);
  });

  it("treats a holiday as no session", () => {
    const hol = [{ d: "2026-11-23", kind: "holiday" }] as unknown as Parameters<
      typeof rerunRefusal
    >[2];
    expect(rerunRefusal("2026-11-20", "2026-11-23", hol)).toBeNull();
  });

  it("refuses a future, missing or malformed date", () => {
    expect(rerunRefusal("2026-11-23", "2026-11-21", none)).toMatch(/future/);
    expect(rerunRefusal(null, "2026-11-21", none)).toMatch(/needs --date/);
    for (const bad of ["20-11-2026", "2026-11-2", "2026-13-45", "x; rm -rf /"])
      expect(rerunRefusal(bad, "2026-11-21", none)).toMatch(/needs --date/);
  });
});

describe("signals --rerun", () => {
  // 00:57 Sat 21 Nov Melbourne, when the 2b of the 20 Nov rerun ran.
  const NOW = Date.parse("2026-11-20T13:57:00.000Z");

  async function run(argv: string[]) {
    const url = tempDbUrl();
    const db = track(createClient({ url }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    const lines: string[] = [];
    const code = await signalsMain(
      argv,
      { TURSO_MAIN_URL: url },
      {
        nowMs: () => NOW,
        out: (s) => lines.push(s),
        sleep: async () => {},
        openDb: (u) => createClient({ url: u, intMode: "bigint" }),
      },
    );
    const runs = await db.execute(
      "SELECT concurrency_key AS key FROM run_record WHERE concurrency_key LIKE 'arena-2b:%'",
    );
    return { code, lines, keys: runs.rows.map((r) => String(r.key)) };
  }

  it("decides Friday's session (keyed by Friday, not the Saturday)", async () => {
    const r = await run(["--date", "2026-11-20", "--rerun", "--phase", "2b"]);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith("arena-2b AU 2026-11-20:"))).toBe(true);
    expect(r.keys).toEqual(["arena-2b:AU:2026-11-20"]);
  });

  it("refuses an older session with exit 2 and writes no run record", async () => {
    const r = await run(["--date", "2026-11-19", "--rerun", "--phase", "2b"]);
    expect(r.code).toBe(2);
    expect(r.lines).toContain(
      "arena-2b: refused (rerun date is not the latest session (a later session has traded))",
    );
    expect(r.keys).toEqual([]);
  });

  it("without --rerun a --date is unchanged (replays and tests keep naming any date)", async () => {
    const r = await run(["--date", "2026-11-19", "--phase", "2b"]);
    expect(r.code).toBe(0);
    expect(r.keys).toEqual(["arena-2b:AU:2026-11-19"]);
  });
});
