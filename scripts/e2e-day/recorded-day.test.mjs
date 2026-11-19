// M18 D2 (OPS-107, D-964, D-965; AT-84): the recorded-day orchestrator with stubbed steps. No network, no
// database, no process of the real day is started: the plan, the clock, the guard markers and the
// refusal count are checked as data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GUARD_URL,
  ROUTES,
  addDays,
  assertNetwork,
  buildPlan,
  expectedLabels,
  main,
  melbourneInstant,
  melbourneParts,
  nextWeekday,
  previousWeekday,
  runPlan,
  signedCall,
  timeline,
} from "./recorded-day.mjs";
import { hmacMessage } from "../../src/lib/security/hmacCore.mjs";
import { createHash, createHmac } from "node:crypto";

const cfg = (date = "2026-11-12", over = {}) => ({
  work: "/w",
  fixtures: "/f",
  recordedDate: "2026-10-21",
  tl: timeline(date),
  seed: async () => 0,
  appPhase: async () => 0,
  ...over,
});

test("time: Melbourne local times resolve across daylight saving (AEDT in November, AEST in July)", () => {
  assert.equal(
    new Date(melbourneInstant("2026-11-12", "17:30")).toISOString(),
    "2026-11-12T06:30:00.000Z",
  );
  assert.equal(
    new Date(melbourneInstant("2026-07-09", "17:30")).toISOString(),
    "2026-07-09T07:30:00.000Z",
  );
  const t = melbourneParts(Date.parse("2026-11-12T06:30:00Z"));
  assert.deepEqual(t, { date: "2026-11-12", hhmm: "17:30" });
});

test("time: weekdays: a Friday is followed by Monday, a weekend steps back to Friday", () => {
  assert.equal(nextWeekday("2026-11-13"), "2026-11-16"); // Friday -> Monday
  assert.equal(nextWeekday("2026-11-12"), "2026-11-13");
  assert.equal(previousWeekday("2026-11-15"), "2026-11-13"); // Sunday -> Friday
  assert.equal(previousWeekday("2026-11-14"), "2026-11-13");
  assert.equal(previousWeekday("2026-11-12"), "2026-11-12");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
});

test("the simulated day: batch 1 at 17:30, 2a at 17:50, 2b at 18:10, review at 20:00, the morning slots before them", () => {
  const tl = timeline("2026-11-12");
  const hhmm = (iso) => melbourneParts(Date.parse(iso)).hhmm;
  assert.equal(hhmm(tl.batch1), "17:30");
  assert.equal(hhmm(tl.closeBooks), "17:50");
  assert.equal(hhmm(tl.signals), "18:10");
  assert.equal(hhmm(tl.evening[0].at), "20:00");
  assert.deepEqual(
    tl.morning.map((p) => [p.id, melbourneParts(Date.parse(p.at)).date, hhmm(p.at)]),
    [
      ["sentinel", "2026-11-12", "08:30"],
      ["preopen", "2026-11-12", "09:54"],
      ["quote-poll", "2026-11-12", "10:20"],
      ["scan-1", "2026-11-12", "10:32"],
      ["scan-2", "2026-11-12", "11:02"],
      ["scan-3", "2026-11-12", "11:32"],
    ],
  );
  // three intraday scan slots and one quote poll, as the Worker's slots
  assert.equal(tl.morning.filter((p) => p.calls.includes("intraday-scan")).length, 3);
  assert.equal(tl.morning.filter((p) => p.calls.includes("quote-poll")).length, 1);
  // the app phases never go back in time
  const at = [...tl.morning, ...tl.evening].map((p) => Date.parse(p.at));
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
  );
});

test("the plan: the order of the day, every spawned script guarded, the simulated clock on the three time-bound scripts", () => {
  const plan = buildPlan(cfg());
  assert.deepEqual(
    plan.map((s) => s.id),
    [
      "migrate-main",
      "migrate-auth",
      "seed",
      "build",
      "app-sentinel",
      "app-preopen",
      "app-quote-poll",
      "app-scan-1",
      "app-scan-2",
      "app-scan-3",
      "batch1-prepare",
      "recorded-source",
      "batch1-run",
      "close-books",
      "signals",
      "app-evening",
    ],
  );
  // the simulated clock never goes back: app phases carry their instant, scripts carry --now
  const instants = plan
    .map((s) =>
      s.at ? s.at : s.args?.includes("--now") ? s.args[s.args.indexOf("--now") + 1] : null,
    )
    .filter(Boolean)
    .map(Date.parse);
  assert.equal(instants.length, 6 + 4 + 1);
  assert.deepEqual(
    [...instants].sort((a, b) => a - b),
    instants,
  );
  for (const s of plan.filter((x) => x.kind === "spawn" && x.id !== "build")) {
    assert.equal(s.guard, true, s.id);
    assert.deepEqual(s.args.slice(0, 2), ["--import", GUARD_URL], s.id);
  }
  assert.equal(plan.find((s) => s.id === "build").guard, false); // the Next build makes no request
  const now = (id) =>
    plan.find((s) => s.id === id).args[plan.find((s) => s.id === id).args.indexOf("--now") + 1];
  assert.equal(now("batch1-prepare"), "2026-11-12T06:30:00.000Z");
  assert.equal(now("batch1-run"), "2026-11-12T06:30:00.000Z");
  assert.equal(now("close-books"), "2026-11-12T06:50:00.000Z");
  assert.equal(now("signals"), "2026-11-12T07:10:00.000Z");
  const date = (id) => plan.find((s) => s.id === id).args;
  assert.ok(date("close-books").includes("2026-11-12") && date("signals").includes("2026-11-12"));
});

test("the plan: no script path or argument names a market-data host, and no secret is in an argument", () => {
  const text = JSON.stringify(buildPlan(cfg()).map((s) => [s.cmd, s.args]));
  assert.doesNotMatch(text, /yahoo|asx\.com|asic\.gov|https?:\/\//i);
  assert.doesNotMatch(text, /secret|token|key/i);
});

test("runPlan: runs in order, a spawned step goes to exec, a function step runs here", async () => {
  const seen = [];
  const plan = [
    { id: "a", kind: "spawn", label: "a", guard: true },
    {
      id: "b",
      kind: "fn",
      label: "orchestrator",
      guard: false,
      run: async () => (seen.push("b-ran"), 0),
    },
    { id: "c", kind: "spawn", label: "c", guard: true },
  ];
  const lines = [];
  const r = await runPlan(plan, {
    exec: async (s) => (seen.push(`exec:${s.id}`), 0),
    out: (s) => lines.push(s),
  });
  assert.deepEqual(r, { code: 0, failed: null, ran: ["a", "b", "c"] });
  assert.deepEqual(seen, ["exec:a", "b-ran", "exec:c"]);
  assert.deepEqual(lines, ["recorded-day: a ok", "recorded-day: b ok", "recorded-day: c ok"]);
});

test("runPlan: the first failing step stops the day (exit 1, its id named, later steps never run)", async () => {
  const seen = [];
  const plan = ["a", "b", "c"].map((id) => ({ id, kind: "spawn", label: id, guard: true }));
  const r = await runPlan(plan, {
    exec: async (s) => (seen.push(s.id), s.id === "b" ? 3 : 0),
    out: () => {},
  });
  assert.deepEqual(r, { code: 1, failed: "b", ran: ["a", "b"] });
  assert.deepEqual(seen, ["a", "b"]);
  // a step that throws is a failure too
  const t = await runPlan(
    [{ id: "x", kind: "fn", guard: false, run: async () => Promise.reject(new Error("boom")) }],
    {
      exec: async () => 0,
      out: () => {},
    },
  );
  assert.equal(t.failed, "x");
});

test("the network assertion: a refusal fails, a missing guard marker fails, both ok passes", () => {
  const expected = ["app-evening", "batch1-run", "orchestrator"];
  const good =
    "guard-installed app-evening\nguard-installed batch1-run\nguard-installed orchestrator\n";
  assert.deepEqual(assertNetwork(good, expected), {
    ok: true,
    refused: 0,
    missing: [],
    problems: [],
  });
  const refused = assertNetwork(`${good}refused batch1-run\n`, expected);
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, 1);
  assert.match(refused.problems[0], /1 request\(s\) to a non-loopback host were refused/);
  const missing = assertNetwork("guard-installed orchestrator\n", expected);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["app-evening", "batch1-run"]);
  assert.match(missing.problems[0], /no guard marker from: app-evening, batch1-run/);
  assert.equal(assertNetwork("", expected).ok, false); // an empty log is not a pass
});

test("expectedLabels: every guarded process of the plan, once, sorted; the build is not one", () => {
  const labels = expectedLabels(buildPlan(cfg()));
  assert.ok(
    labels.includes("signals") && labels.includes("app-evening") && labels.includes("app-scan-3"),
  );
  assert.ok(!labels.includes("build") && !labels.includes("orchestrator")); // the fn seed step is not guarded
  assert.deepEqual(labels, [...new Set(labels)].sort());
});

test("a signed call: scheme v2 over method, path and body hash; the Sentinel body carries the feed hash", () => {
  const secret = "ab".repeat(32);
  const c = signedCall("preopen", {
    secret,
    nowSec: 1_800_000_000,
    d: "2026-11-13",
    nonce: "n".repeat(32),
  });
  assert.equal(c.path, "/api/internal/preopen");
  assert.deepEqual(JSON.parse(c.body), {
    purpose: "preopen",
    env: "staging",
    d: "2026-11-13",
    slot: "pre-open",
    attempt: 1,
  });
  assert.equal(c.headers["X-Praxis-Version"], "2");
  assert.equal(c.headers["Content-Type"], "application/json");
  const message = hmacMessage({
    method: "POST",
    path: c.path,
    timestamp: "1800000000",
    nonce: "n".repeat(32),
    bodySha256Hex: createHash("sha256").update(c.body, "utf8").digest("hex"),
  });
  const sig = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  assert.ok(Object.values(c.headers).includes(sig));
  const s = signedCall("sentinel", {
    secret,
    nowSec: 1,
    d: "2026-11-13",
    nonce: "m".repeat(32),
    feed: "FEED",
  });
  const body = JSON.parse(s.body);
  assert.equal(body.purpose, "sentinel-ingest");
  assert.equal(body.sha, createHash("sha256").update("FEED", "utf8").digest("hex"));
  assert.equal(body.feed, "FEED");
  assert.throws(() => signedCall("made-up", { secret, nowSec: 1, d: "x", nonce: "y" }));
  assert.deepEqual(Object.keys(ROUTES).sort(), [
    "evening-review",
    "intraday-scan",
    "preopen",
    "quote-poll",
    "sentinel",
  ]);
});

function work() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-rd-"));
  return dir;
}
const clean = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

test("assert-net (the job's last step): exit 1 on any refusal, exit 1 on a missing marker, exit 0 when clean", async () => {
  const dir = work();
  try {
    writeFileSync(path.join(dir, "labels.json"), JSON.stringify(["app-evening", "orchestrator"]));
    const lines = [];
    const run = () => main(["assert-net", "--work", dir], {}, { out: (s) => lines.push(s) });
    writeFileSync(
      path.join(dir, "net.log"),
      "guard-installed app-evening\nguard-installed orchestrator\n",
    );
    assert.equal(await run(), 0);
    writeFileSync(
      path.join(dir, "net.log"),
      "guard-installed app-evening\nguard-installed orchestrator\nrefused app-evening\n",
    );
    assert.equal(await run(), 1);
    writeFileSync(path.join(dir, "net.log"), "guard-installed orchestrator\n");
    assert.equal(await run(), 1);
    assert.match(lines.join("\n"), /no guard marker from: app-evening/);
    assert.doesNotMatch(lines.join("\n"), /https?:/);
  } finally {
    clean(dir);
  }
});

test("assert-net without a log or labels fails (the day never started)", async () => {
  const dir = work();
  try {
    assert.equal(await main(["assert-net", "--work", dir], {}, { out: () => {} }), 1);
  } finally {
    clean(dir);
  }
});

test("check runs check.mjs --db on the run's database at the simulated evening, under the guard", async () => {
  const dir = work();
  try {
    writeFileSync(
      path.join(dir, "day.json"),
      JSON.stringify({ date: "2026-11-12", check: "2026-11-12T10:00:00.000Z" }),
    );
    const seen = [];
    const code = await main(["check", "--work", dir], {}, { exec: async (s) => (seen.push(s), 0) });
    assert.equal(code, 0);
    const a = seen[0].args;
    assert.deepEqual(a.slice(0, 3), ["--import", GUARD_URL, "scripts/e2e-day/check.mjs"]);
    assert.equal(a[a.indexOf("--db") + 1], path.join(dir, "main.db"));
    assert.equal(a[a.indexOf("--date") + 1], "2026-11-12");
    assert.equal(a[a.indexOf("--now") + 1], "2026-11-12T10:00:00.000Z");
    assert.equal(await main(["check", "--work", dir], {}, { exec: async () => 1 }), 1);
  } finally {
    clean(dir);
  }
});

test("arguments: unknown command, missing --work or --fixtures, bad date exit 2", async () => {
  for (const argv of [
    [],
    ["bogus", "--work", "w"],
    ["run", "--fixtures", "f"],
    ["run", "--work", "w"],
    ["run", "--work", "w", "--fixtures", "f", "--date", "tomorrow"],
    ["check", "--bogus"],
  ]) {
    assert.equal(await main(argv, {}, { out: () => {} }), 2, argv.join(" "));
  }
});

// The preload: the guard installs in a real process, refuses a non-loopback request, counts it and writes
// the marker; it refuses to run outside the recorded environment.
const guardArgs = ["--import", GUARD_URL, "-e"];
test("guard.mjs: refuses to start outside PRAXIS_ENV=recorded", () => {
  const r = spawnSync(process.execPath, [...guardArgs, "0"], {
    env: { PATH: process.env.PATH, PRAXIS_ENV: "production" },
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
});

test("guard.mjs: a process under it writes its marker, a request to another host is refused and counted, loopback is not", () => {
  const dir = work();
  const log = path.join(dir, "net.log");
  try {
    const script = `
      const net = require("node:net");
      const s = net.createServer((c) => c.end()).listen(0, "127.0.0.1", async () => {
        const port = s.address().port;
        let blocked = 0;
        await fetch("https://example.com/x").catch(() => { blocked += 1; });
        await new Promise((res) => { const c = net.connect({ host: "example.org", port: 443 }); c.on("error", () => { blocked += 1; res(); }); });
        await new Promise((res) => { const c = net.connect({ host: "127.0.0.1", port }); c.on("connect", () => { c.end(); res(); }); c.on("error", res); });
        s.close();
        process.stdout.write("blocked=" + blocked);
      });`;
    const r = spawnSync(process.execPath, [...guardArgs, script], {
      env: {
        PATH: process.env.PATH,
        PRAXIS_ENV: "recorded",
        PRAXIS_NET_LOG: log,
        PRAXIS_NET_LABEL: "probe",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.stdout, "blocked=2", r.stderr);
    const text = readFileSync(log, "utf8");
    assert.match(text, /^guard-installed probe$/m);
    assert.equal((text.match(/^refused probe$/gm) ?? []).length, 2);
    assert.doesNotMatch(text, /example|https?:/);
  } finally {
    clean(dir);
  }
});

test("--market IN (built, not enabled in the production-shape database): exit 2 before anything is created (MKT-110 a)", async () => {
  const dir = path.join(tmpdir(), "praxis-rd-refused-never-created");
  const lines = [];
  const code = await main(
    ["run", "--fixtures", dir, "--work", dir, "--market", "IN"],
    {},
    { out: (s) => lines.push(s) },
  );
  assert.equal(code, 2);
  assert.deepEqual(lines, ["recorded-day: refused: market not enabled"]);
  // a bad code is a usage error, also exit 2
  const bad = await main(
    ["run", "--fixtures", dir, "--work", dir, "--market", "in!"],
    {},
    { out: () => {} },
  );
  assert.equal(bad, 2);
});

// ---- M20 S1 (D-1119, TST-139): the data-only development day of IN and US ------------------------------------------

import { mkdirSync } from "node:fs";
import { buildDataOnlyPlan, recordedDates, zonedInstant } from "./recorded-day.mjs";
import { seedSlots } from "../../src/lib/market/homeMarket.mjs";

test("zonedInstant: the market's own wall clock resolves, half-hour zones and daylight saving included", () => {
  const iso = (d, t, tz) => new Date(zonedInstant(d, t, tz)).toISOString();
  assert.equal(iso("2026-11-12", "15:30", "Asia/Kolkata"), "2026-11-12T10:00:00.000Z"); // UTC+5:30
  assert.equal(iso("2026-11-12", "16:00", "America/New_York"), "2026-11-12T21:00:00.000Z"); // EST, UTC-5
  assert.equal(iso("2026-07-09", "16:00", "America/New_York"), "2026-07-09T20:00:00.000Z"); // EDT, UTC-4
  assert.equal(iso("2026-11-12", "17:30", "Australia/Sydney"), "2026-11-12T06:30:00.000Z");
  assert.throws(
    () => zonedInstant("2026-03-08", "02:30", "America/New_York"),
    /no such local time/,
  ); // the spring gap
});

test("recordedDates: the dated folders of recorded/<CODE>, oldest first, at most N; none for a missing folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rd-dev-"));
  try {
    for (const d of ["2026-11-05", "2026-11-03", "2026-11-04", "not-a-date", "2026-11-06"]) {
      mkdirSync(path.join(dir, "recorded", "IN", d), { recursive: true });
    }
    writeFileSync(path.join(dir, "recorded", "IN", "2026-11-07"), "a file, not a day");
    assert.deepEqual(recordedDates(dir, "IN", 3), ["2026-11-03", "2026-11-04", "2026-11-05"]);
    assert.deepEqual(recordedDates(dir, "IN", 10), [
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    assert.deepEqual(recordedDates(dir, "US"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the data-only plan: migrate, seed, then per session prepare -> recorded source -> run -> verdict; guarded; no app, close or review", () => {
  const calls = [];
  const plan = buildDataOnlyPlan({
    work: "/w",
    fixtures: "/f",
    market: "IN",
    dates: ["2026-11-03", "2026-11-04"],
    seed: async () => calls.push("seed"),
    verdict: async (d) => calls.push(`verdict ${d}`),
  });
  assert.deepEqual(
    plan.map((s) => s.id),
    [
      "migrate-main",
      "migrate-auth",
      "seed-dev",
      "batch1-prepare-2026-11-03",
      "recorded-source-2026-11-03",
      "batch1-run-2026-11-03",
      "verdict-2026-11-03",
      "batch1-prepare-2026-11-04",
      "recorded-source-2026-11-04",
      "batch1-run-2026-11-04",
      "verdict-2026-11-04",
    ],
  );
  const spawned = plan.filter((s) => s.kind === "spawn");
  assert.ok(
    spawned.every((s) => s.guard === true && s.args[0] === "--import" && s.args[1] === GUARD_URL),
  );
  // every batch-1 script names the market and runs at the market's own batch time in its own zone (IN: UTC+5:30, no DST)
  const b1 = seedSlots("IN").b1;
  const [h, m] = b1.split(":").map(Number);
  const wantMs = Date.parse(`2026-11-03T00:00:00Z`) + (h * 60 + m - 330) * 60_000;
  for (const s of spawned.filter((x) => x.id.startsWith("batch1-"))) {
    assert.equal(s.args[s.args.indexOf("--market") + 1], "IN");
  }
  const first = plan.find((s) => s.id === "batch1-prepare-2026-11-03");
  assert.equal(first.args[first.args.indexOf("--now") + 1], new Date(wantMs).toISOString());
  const src = plan.find((s) => s.id === "recorded-source-2026-11-03");
  assert.equal(src.args[src.args.indexOf("--date") + 1], "2026-11-03");
  const text = JSON.stringify(plan);
  for (const banned of ["close-books", "signals", "evening", "next", "app-"]) {
    assert.ok(!text.includes(banned), banned);
  }
});

test("run --mode data_only refuses before anything is created: the market must be IN or US and named by PRAXIS_MARKETS_ENABLED", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rd-dev-"));
  try {
    const lines = [];
    const run = (argv, env) => main(argv, env, { out: (l) => lines.push(l), exec: async () => 0 });
    const base = ["run", "--fixtures", dir, "--work", path.join(dir, "w"), "--mode", "data_only"];
    // the variable does not name the market: refused, exit 2, nothing created
    assert.equal(await run([...base, "--market", "IN"], {}), 2);
    assert.equal(await run([...base, "--market", "IN"], { PRAXIS_MARKETS_ENABLED: "AU" }), 2);
    assert.equal(lines[0], "recorded-day: refused: market not enabled");
    // the home market is never a development day (it is the production shape)
    assert.equal(await run([...base, "--market", "AU"], { PRAXIS_MARKETS_ENABLED: "AU" }), 2);
    // a named market with no recorded session: exit 2 with its own words
    lines.length = 0;
    assert.equal(await run([...base, "--market", "US"], { PRAXIS_MARKETS_ENABLED: "AU,US" }), 2);
    assert.equal(lines[0], "recorded-day: no recorded session for the market in the fixtures");
    // --mode data_only needs a market; a bad mode is a usage error
    assert.equal(
      await run(["run", "--fixtures", dir, "--work", dir, "--mode", "data_only"], {}),
      2,
    );
    assert.equal(await run([...base.slice(0, 5), "--mode", "weird", "--market", "IN"], {}), 2);
    assert.equal(existsSync(path.join(dir, "w")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("has-sessions: found only when recorded/<CODE> holds a dated folder; it writes found=... to GITHUB_OUTPUT", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rd-dev-"));
  try {
    const out = path.join(dir, "gh-output");
    writeFileSync(out, "");
    const lines = [];
    const ask = (market) =>
      main(
        ["has-sessions", "--fixtures", dir, "--market", market],
        { GITHUB_OUTPUT: out },
        { out: (l) => lines.push(l) },
      );
    assert.equal(await ask("IN"), 0);
    assert.equal(readFileSync(out, "utf8"), "found=false\n");
    mkdirSync(path.join(dir, "recorded", "IN", "2026-11-03"), { recursive: true });
    assert.equal(await ask("IN"), 0);
    assert.equal(readFileSync(out, "utf8"), "found=false\nfound=true\n");
    assert.deepEqual(lines, [
      "recorded-day: recorded sessions not found",
      "recorded-day: recorded sessions found",
    ]);
    assert.equal(await main(["has-sessions", "--market", "IN"], {}, { out: () => {} }), 2); // --fixtures is required
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
