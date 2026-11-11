// M19 C2 (MKT-110 a, AT-68 (a), D-996): every script that writes a market-keyed row takes `--market` with no
// literal default and refuses a market that is not enabled BEFORE its first write: exit 2, the fixed line
// `refused: market not enabled`, and no run record (a run record for that market would itself be a refused
// write). Omitted = the single enabled market; two or more enabled and no flag = exit 2 "market required".
// A real migrated libSQL file (0034 seed: AU enabled, IN and US built and off); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import yaml from "js-yaml";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import {
  REFUSED_LINE,
  REQUIRED_LINE,
  UNSUPPORTED_LINE,
  assertMarketEnabled,
  resolveScriptMarket,
  takeMarketFlag,
} from "../../src/lib/market/scriptMarket.mjs";
import { run as batch1 } from "./batch1.mjs";
import { run as historyBackfill } from "../backfill/run.mjs";
import { run as priceBackfill } from "../backfill/prices.mjs";
import { run as indexBackfill } from "../backfill/index.mjs";
import { run as calendarDraft } from "../calendar/draft.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = Date.parse("2026-10-13T06:30:00.000Z"); // Tuesday 13 Oct 2026, 17:30 Sydney

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-mr-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  const lines = [];
  const deps = {
    openDb: (u) => createClient({ url: u }),
    nowMs: () => NOW,
    out: (s) => lines.push(s),
  };
  const env = {
    TURSO_MAIN_URL: url,
    TURSO_MAIN_TOKEN: "unused-for-file",
    COMMIT_SHA: "c".repeat(40),
  };
  const runRecords = async () =>
    Number((await db.execute("SELECT COUNT(*) AS n FROM run_record")).rows[0].n);
  const cleanup = () => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows lock: the folder holds a scratch database only
    }
  };
  return { db, dir, env, deps, lines, runRecords, cleanup };
}

test("takeMarketFlag: the flag, an empty value and a bad code", () => {
  assert.deepEqual(takeMarketFlag(["run", "--market", "IN", "--bars", "b.json"]), {
    argv: ["run", "--bars", "b.json"],
    market: "IN",
    error: null,
  });
  assert.equal(takeMarketFlag(["run", "--market", ""]).market, null);
  assert.equal(takeMarketFlag(["run", "--market=AU"]).market, "AU");
  assert.ok(takeMarketFlag(["run", "--market", "in!"]).error);
  assert.ok(takeMarketFlag(["run", "--market"]).error);
});

test("resolveScriptMarket: omitted = the single enabled market; named but not enabled is refused", async () => {
  const t = await setup();
  try {
    assert.deepEqual(await resolveScriptMarket(t.db, null), { ok: true, market: "AU" });
    assert.deepEqual(await resolveScriptMarket(t.db, "AU"), { ok: true, market: "AU" });
    assert.deepEqual(await resolveScriptMarket(t.db, "IN"), {
      ok: false,
      line: REFUSED_LINE,
      exit: 2,
    });
    assert.deepEqual(await resolveScriptMarket(t.db, "US"), {
      ok: false,
      line: REFUSED_LINE,
      exit: 2,
    });
    assert.equal(
      (await resolveScriptMarket(t.db, "AU", { supported: ["XX"] })).line,
      UNSUPPORTED_LINE,
    );
    await assert.rejects(() => assertMarketEnabled(t.db, "IN"), { name: "MarketNotEnabled" });
    await assertMarketEnabled(t.db, "AU");
    // two enabled, no flag: the script must not guess
    await t.db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    assert.deepEqual(await resolveScriptMarket(t.db, null), {
      ok: false,
      line: REQUIRED_LINE,
      exit: 2,
    });
    assert.deepEqual(await resolveScriptMarket(t.db, "IN"), { ok: true, market: "IN" });
    // none enabled
    await t.db.execute("UPDATE market SET mode = 'off' WHERE code = 'AU'");
    await t.db.execute("UPDATE market SET enabled = 0");
    assert.deepEqual(await resolveScriptMarket(t.db, null), {
      ok: false,
      line: REFUSED_LINE,
      exit: 2,
    });
  } finally {
    t.cleanup();
  }
});

test("batch 1 --market IN under the seed: exit 2, the refusal line, no run record, no write", async () => {
  const t = await setup();
  try {
    for (const cmd of [
      ["prepare", "--request", path.join(t.dir, "r.json")],
      ["run", "--bars", path.join(t.dir, "b.json")],
    ]) {
      t.lines.length = 0;
      const code = await batch1([cmd[0], "--market", "IN", ...cmd.slice(1)], t.env, t.deps);
      assert.equal(code, 2, cmd[0]);
      assert.match(t.lines.join("\n"), /refused: market not enabled/);
      assert.equal(await t.runRecords(), 0);
    }
    const bars = Number((await t.db.execute("SELECT COUNT(*) AS n FROM price_bar")).rows[0].n);
    assert.equal(bars, 0);
  } finally {
    t.cleanup();
  }
});

test("batch 1 with two enabled markets and no --market: exit 2 market required, nothing written", async () => {
  const t = await setup();
  try {
    await t.db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    const code = await batch1(["run", "--bars", path.join(t.dir, "b.json")], t.env, t.deps);
    assert.equal(code, 2);
    assert.match(t.lines.join("\n"), /market required/);
    assert.equal(await t.runRecords(), 0);
  } finally {
    t.cleanup();
  }
});

test("the history, price and index backfills refuse a market that is not enabled, or one they have no source for", async () => {
  const t = await setup();
  try {
    writeFileSync(path.join(t.dir, "index.json"), "[]");
    const cases = [
      [historyBackfill, ["plan", "--market", "IN", "--out", path.join(t.dir, "p.json")]],
      [priceBackfill, ["plan", "--market", "US", "--out", path.join(t.dir, "q.json")]],
      [
        indexBackfill,
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
      ],
    ];
    for (const [fn, argv] of cases) {
      t.lines.length = 0;
      assert.equal(await fn(argv, t.env, t.deps), 2, argv[0]);
      assert.match(t.lines.join("\n"), /refused: market not enabled/);
    }
    // an enabled market the job has no source for: refused as unsupported, nothing written
    await t.db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    t.lines.length = 0;
    assert.equal(
      await historyBackfill(
        ["plan", "--market", "IN", "--out", path.join(t.dir, "p.json")],
        t.env,
        t.deps,
      ),
      2,
    );
    assert.match(t.lines.join("\n"), /not supported by this job/);
    assert.equal(await t.runRecords(), 0);
  } finally {
    t.cleanup();
  }
});

test("calendar draft names only enabled markets: --market IN is refused, the default skips IN and US", async () => {
  const t = await setup();
  try {
    const lines = [];
    const connect = async () => createClient({ url: t.env.TURSO_MAIN_URL });
    const code = await calendarDraft(
      ["--market", "IN", "--year", "2027", "--now", "2026-11-01T00:00:00Z"],
      t.env,
      (s) => lines.push(s),
      { connect },
    );
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /refused: market not enabled/);
    assert.equal(
      Number(
        (await t.db.execute("SELECT COUNT(*) AS n FROM trading_calendar WHERE market = 'IN'"))
          .rows[0].n,
      ),
      0,
    );
    assert.equal(await t.runRecords(), 0);
    lines.length = 0;
    const ok = await calendarDraft(
      ["--year", "2099", "--now", "2026-11-01T00:00:00Z"],
      t.env,
      (s) => lines.push(s),
      { connect },
    );
    assert.equal(ok, 1); // 2099 is out of the draftable window: the named enabled market runs and reports bad_year
    assert.match(lines.join("\n"), /bad_year/);
    assert.doesNotMatch(lines.join("\n"), /\bIN\b|\bUS\b/);
  } finally {
    t.cleanup();
  }
});

// ---- the dispatching workflows carry the market input to the script (D-996) -------------------------------------
const WORKFLOWS = {
  "ingest-batch1": ["batch1.mjs prepare", "batch1.mjs run"],
  "arena-close": ["close-books.mjs"],
  "arena-signals": ["signals.mjs"],
  replay: ["replay/run.mjs"],
  "backfill-history": ["backfill/run.mjs plan", "backfill/run.mjs commit"],
  "backfill-prices": ["backfill/prices.mjs plan", "backfill/prices.mjs commit"],
  "backfill-index": ["backfill/index.mjs commit"],
};
const FLAG = '${MARKET_INPUT:+--market "$MARKET_INPUT"}';
const EXPR = "${{ inputs.market }}";
const wfFile = (n) => path.join(root, ".github", "workflows", `${n}.yml`);

for (const [name, scripts] of Object.entries(WORKFLOWS)) {
  test(`workflow ${name}: a market input (default empty) reaches the script through env, never the script text`, () => {
    const wf = yaml.load(readFileSync(wfFile(name), "utf8"));
    const input = wf.on.workflow_dispatch.inputs.market;
    assert.equal(input.type, "string");
    assert.equal(input.required, false);
    assert.equal(input.default, "");
    for (const frag of scripts) {
      const step = wf.jobs.production.steps.find(
        (s) => typeof s.run === "string" && s.run.includes(frag),
      );
      assert.ok(step, frag);
      assert.ok(step.run.includes(FLAG), `${frag}: the flag is passed only when the input is set`);
      assert.equal(step.env.MARKET_INPUT, EXPR);
      assert.ok(!step.run.includes("${{"), "no expression inside the script text (injection)");
    }
  });
}

test("workflow calendar-draft: the market input already exists and reaches the script through env", () => {
  const wf = yaml.load(readFileSync(wfFile("calendar-draft"), "utf8"));
  assert.equal(wf.on.workflow_dispatch.inputs.market.default, "");
  const step = wf.jobs.production.steps.find((s) =>
    String(s.run ?? "").includes("calendar/draft.mjs"),
  );
  assert.ok(step.run.includes('--market "$MARKET_INPUT"'));
  assert.equal(step.env.MARKET_INPUT, EXPR);
});
