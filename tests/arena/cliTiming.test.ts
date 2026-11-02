// @vitest-environment node
// D-878: the signals command prints one line per stage boundary of batch 2b and batch 3
// (`arena-2b AU <d>: stage=… ms=… [note]`, `arena-3 …`), with and without a count note. The two
// batches are replaced by stubs that report stages, so this pins only the command line's formatting.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { signalsMain } from "@/lib/arena/cli";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

const zeroStats = {
  cohorts: 0,
  signals: 0,
  orders: 0,
  rejected: 0,
  exits: 0,
  stopLevels: 0,
  controls: 0,
  skips: 0,
  ledger: null,
  statRows: 0,
  invariantViolations: 0,
  killLooks: 0,
  killTriggered: 0,
  evidenceRows: 0,
};

vi.mock("@/lib/agents/batch2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/batch2b")>()),
  signalsDay: vi.fn(
    async (
      _db: Client,
      o: { d: string; onTiming?: (stage: string, ms: number, note?: string) => void },
    ) => {
      o.onTiming?.("candidates", 12, "codes=3");
      o.onTiming?.("write", 7);
      return { market: "AU", d: o.d, status: "success", reason: null, stats: zeroStats };
    },
  ),
}));

vi.mock("@/lib/agents/batch3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/batch3")>()),
  reviewDay: vi.fn(
    async (
      _db: Client,
      o: { d: string; onStage?: (stage: string, ms: number, note?: string) => void },
    ) => {
      o.onStage?.("ledger", 21, "opened=1 closed=0");
      o.onStage?.("cortex_outcome", 4);
      return { market: "AU", d: o.d, status: "success", reason: null, stats: zeroStats };
    },
  ),
}));

afterEach(cleanupTempDbs);

const NOW = Date.parse("2026-10-20T08:00:00.000Z");
const D = "2026-10-20";

async function run(phase: string): Promise<string[]> {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
  const lines: string[] = [];
  const code = await signalsMain(
    ["--date", D, "--phase", phase],
    { TURSO_MAIN_URL: url },
    {
      nowMs: () => NOW,
      out: (s) => lines.push(s),
      sleep: async () => {},
      openDb: (u) => createClient({ url: u, intMode: "bigint" }),
    },
  );
  expect(code).toBe(0);
  return lines;
}

describe("stage timing lines", () => {
  it("2b prints each stage with its note, or without one", async () => {
    const lines = await run("2b");
    expect(lines).toContain("arena-2b AU 2026-10-20: stage=candidates ms=12 codes=3");
    expect(lines).toContain("arena-2b AU 2026-10-20: stage=write ms=7");
  });

  it("3 prints each stage with its note, or without one", async () => {
    const lines = await run("3");
    expect(lines).toContain("arena-3 AU 2026-10-20: stage=ledger ms=21 opened=1 closed=0");
    expect(lines).toContain("arena-3 AU 2026-10-20: stage=cortex_outcome ms=4");
  });
});
