// @vitest-environment node
// `signals --phase 2b|3|learn|words|all` (M6 T11; design 4.1): the order 2b -> 3 -> learn -> words, the
// data-only guard as before, partial runs after a missing predecessor, the reduced non-trading run,
// idempotent reruns, and statuses-and-counts-only output. The deeper cases are in learnStage.test.ts
// and wordsStage.test.ts; this drives the CLI entry point on a real migrated file.
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { signalsMain } from "@/lib/arena/cli";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = Date.parse("2026-10-20T08:00:00.000Z"); // Tuesday 20 Oct 2026, 19:00 Sydney
const D = "2026-10-20";
const SAT = "2026-10-17";

async function fileDb(mode: "full" | "data_only"): Promise<{ url: string; db: Client }> {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = 'AU'", args: [mode] });
  return { url, db };
}

async function cli(url: string, args: string[], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const code = await signalsMain(
    args,
    { TURSO_MAIN_URL: url, ...env },
    {
      nowMs: () => NOW,
      out: (s) => lines.push(s),
      sleep: async () => {},
      openDb: (u) => createClient({ url: u, intMode: "bigint" }),
    },
  );
  return { code, lines };
}

const jobs = async (db: Client): Promise<string[]> =>
  (await db.execute("SELECT job FROM run_record ORDER BY id")).rows.map((r) => String(r.job));

async function addRun(db: Client, key: string, job: string, d: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
          VALUES (?, 'AU', ?, ?, ?, ?, 'success')`,
    args: [job, key, d, `${d}T08:00:00.000Z`, `${d}T08:05:00.000Z`],
  });
}

describe("arguments", () => {
  it("accepts 2b, 3, learn, words and all; anything else is refused with exit 2", async () => {
    const { url } = await fileDb("data_only");
    for (const phase of ["2b", "3", "learn", "words", "all"]) {
      const r = await cli(url, ["--date", D, "--phase", phase]);
      expect(r.code, phase).not.toBe(2);
    }
    const bad = await cli(url, ["--phase", "reports"]);
    expect(bad.code).toBe(2);
    expect(bad.lines[0]).toContain("--phase must be 2b, 3, learn, words or all");
  });
});

describe("the data-only guard (D-066, BLD-024)", () => {
  it("`all` prints the one 2b skip and stops; no learn or words record, nothing written", async () => {
    const { url, db } = await fileDb("data_only");
    const r = await cli(url, ["--date", D]);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^arena-2b AU 2026-10-20: skipped \(data_only_guard\)/);
    expect(await jobs(db)).toEqual(["arena-signals"]);
  });

  it("`--phase learn` and `--phase words` alone record a skip each and touch no table", async () => {
    const { url, db } = await fileDb("data_only");
    const l = await cli(url, ["--date", D, "--phase", "learn"]);
    const w = await cli(url, ["--date", D, "--phase", "words"]);
    expect(l).toMatchObject({ code: 0 });
    expect(l.lines[0]).toMatch(/^arena-learn AU 2026-10-20: skipped \(data_only_guard\)/);
    expect(w.lines[0]).toMatch(/^arena-words AU 2026-10-20: skipped \(data_only_guard\)/);
    expect(await jobs(db)).toEqual(["arena-learn", "arena-words"]);
    for (const t of [
      "plan_item",
      "plan_review",
      "change_ledger",
      "comparison_result",
      "attribution",
    ]) {
      const n = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
      expect(Number(n.rows[0]!.n), t).toBe(0);
    }
  });
});

describe("order and partial runs", () => {
  it("`all` runs 2b, then learn, then words; a missing 2a/3 makes learn and words partial", async () => {
    const { url, db } = await fileDb("full");
    const out = path.join(mkdtempSync(path.join(tmpdir(), "praxis-out-")), "gh-output.txt");
    const r = await cli(url, ["--date", D, "--replay", "--wait-minutes", "0"], {
      GITHUB_OUTPUT: out,
    });
    // 2a missing: 2b skipped visibly (exit 1), batch 3 not run, but the A6 phases still run on what exists
    expect(r.code).toBe(1);
    const order = r.lines.map((l) => l.split(" ")[0]);
    expect(order).toEqual(["arena-2b", "arena-learn", "arena-words"]);
    expect(r.lines[1]).toMatch(
      /arena-learn AU 2026-10-20: degraded \(batch3_missing\) variant=partial/,
    );
    expect(r.lines[2]).toMatch(
      /arena-words AU 2026-10-20: degraded \(learn_missing\)|arena-words AU 2026-10-20: success/,
    );
    expect(await jobs(db)).toEqual(["arena-signals", "arena-learn", "arena-words"]);
    const gh = readFileSync(out, "utf8").trim().split("\n");
    expect(gh.some((l) => l.startsWith("learn="))).toBe(true);
    expect(gh.some((l) => l.startsWith("words="))).toBe(true);
    // statuses and counts only
    expect(r.lines.join("\n")).not.toMatch(/file:|libsql|token|secret/i);
  });

  it("learn then words alone follow a finished batch 3 in order and are idempotent", async () => {
    const { url, db } = await fileDb("full");
    await addRun(db, `arena-2b:AU:${D}`, "arena-signals", D);
    await addRun(db, `arena-3:AU:${D}`, "arena-review", D);
    const l = await cli(url, ["--date", D, "--phase", "learn", "--replay"]);
    const w = await cli(url, ["--date", D, "--phase", "words", "--replay"]);
    expect(l.code).toBe(0);
    expect(w.code).toBe(0);
    expect(l.lines[0]).toMatch(/^arena-learn AU 2026-10-20: success variant=full/);
    expect(w.lines[0]).toMatch(/^arena-words AU 2026-10-20: success/);
    expect(await jobs(db)).toEqual(["arena-signals", "arena-review", "arena-learn", "arena-words"]);
    // a rerun is a no-op
    const again = await cli(url, ["--date", D, "--phase", "learn", "--replay"]);
    expect(again.lines[0]).toMatch(/^arena-learn AU 2026-10-20: already_done/);
    expect((await jobs(db)).length).toBe(4);
  });

  it("a non-trading day runs the reduced learn and the words phase inside `all`", async () => {
    const { url, db } = await fileDb("full");
    const r = await cli(url, ["--date", SAT, "--replay", "--wait-minutes", "0"]);
    expect(r.code).toBe(0); // a non-trading day is an expected skip for 2b
    expect(r.lines[0]).toMatch(/^arena-2b AU 2026-10-17: skipped \(non_trading_day\)/);
    expect(r.lines[1]).toMatch(/^arena-learn AU 2026-10-17: success variant=reduced/);
    expect(r.lines[2]).toMatch(/^arena-words AU 2026-10-17: success/);
    expect(await jobs(db)).toEqual(["arena-signals", "arena-learn", "arena-words"]);
  });
});
