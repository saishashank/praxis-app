// The CI "recorded day" (M18 OPS-107 / D-964 / D-965, TST-138, AT-84): one full AU trading day on LOCAL
// libSQL files with a simulated clock, from the private recorded fixtures. It replaces the staging E2E
// day. Zero requests leave the machine: every process runs with PRAXIS_ENV=recorded, where the host guard
// (src/lib/data/recorded/hostGuard.mjs) refuses every non-loopback host and counts refusals, and writes a
// marker so the job can prove each process had the guard installed.
//
//   node scripts/e2e-day/recorded-day.mjs run --fixtures <dir> --work <dir> [--date YYYY-MM-DD]
//   node scripts/e2e-day/recorded-day.mjs check --work <dir>          PLT-073 deadlines (check.mjs --db)
//   node scripts/e2e-day/recorded-day.mjs assert-net --work <dir>     no refusal, every guard marker present
//
// `run` plan, in order: migrate (main, auth) -> seed (market full, calendar, go-live sign-off, instruments
// of the recording, the three test identities) -> Batch 1 at 17:30 (recorded day, then ingest) -> 2a close
// the books at 17:50 -> 2b signals, batch 3, picks and steelman at 18:10 -> production build -> the app on
// loopback at the simulated times of the day's slots, with signed v2 calls through scripts/smoke/sign.mjs
// (evening review, pre-open re-check, intraday scans, quote poll, Sentinel) -> the viewer walk. The app
// is restarted per time so its simulated clock (PRAXIS_SIM_NOW) is right for each call.
// Output is step ids, statuses and counts only (SEC-110): never a code, a row, a URL or a secret.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  installHostGuard,
  installNetGuard,
  parseNetLog,
  writeGuardMarker,
} from "../../src/lib/data/recorded/hostGuard.mjs";
import { sign } from "../smoke/sign.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GUARD_URL = pathToFileURL(path.join(ROOT, "scripts/e2e-day/guard.mjs")).href;
const PORT = 3100; // threshold-ok: the e2e port, as playwright.config.ts
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEALTH_WAIT_MS = 120_000; // threshold-ok: next start allowance
const STEP_LIMIT_MS = 20 * 60_000; // threshold-ok: one step may not run longer than this
const MARKET = "AU";
const TZ = "Australia/Melbourne";
const HEX = () => randomBytes(32).toString("hex");

// ---- time -------------------------------------------------------------------------------------

/** Melbourne wall clock (date, HH:MM) for an instant. */
export function melbourneParts(ms) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

/** The instant (ms) at which Melbourne shows `date` `hhmm`. Daylight saving is resolved by trial. */
export function melbourneInstant(date, hhmm) {
  const asUtc = Date.parse(`${date}T${hhmm}:00Z`);
  for (const offsetH of [11, 10]) {
    const t = asUtc - offsetH * 3_600_000;
    const m = melbourneParts(t);
    if (m.date === date && m.hhmm === hhmm) return t;
  }
  throw new Error("melbourneInstant: no such local time");
}

const isWeekday = (date) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d !== 0 && d !== 6;
};
export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
export function previousWeekday(date) {
  let d = date;
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}
export function nextWeekday(date) {
  let d = addDays(date, 1);
  while (!isWeekday(d)) d = addDays(d, 1);
  return d;
}

/**
 * The simulated timeline of one trading day D (Melbourne local times), in the order it happens: the
 * `morning` app phases (Sentinel 08:30, pre-open 09:54, quote poll, three intraday scans), the three
 * scripts at 17:30, 17:50 and 18:10, then the `evening` app phase (review send 20:00 and the viewer walk).
 * Each app phase is one start of the app at `at` with the signed calls it makes.
 */
export function timeline(date) {
  const I = (d, t) => new Date(melbourneInstant(d, t)).toISOString();
  return {
    date,
    morning: [
      { id: "sentinel", at: I(date, "08:30"), calls: ["sentinel"] },
      { id: "preopen", at: I(date, "09:54"), calls: ["preopen"] },
      { id: "quote-poll", at: I(date, "10:20"), calls: ["quote-poll"] },
      { id: "scan-1", at: I(date, "10:32"), calls: ["intraday-scan"] },
      { id: "scan-2", at: I(date, "11:02"), calls: ["intraday-scan"] },
      { id: "scan-3", at: I(date, "11:32"), calls: ["intraday-scan"] },
    ],
    batch1: I(date, "17:30"),
    closeBooks: I(date, "17:50"),
    signals: I(date, "18:10"),
    evening: [{ id: "evening", at: I(date, "20:00"), calls: ["evening-review"], walk: true }],
    check: I(date, "21:00"),
  };
}

// ---- signed route calls (the Worker's slots, signed with scheme v2) ------------------------------

export const ROUTES = Object.freeze({
  "evening-review": { path: "/api/internal/evening-review", slot: "evening-review" },
  preopen: { path: "/api/internal/preopen", slot: "pre-open", extra: { attempt: 1 } },
  "intraday-scan": { path: "/api/internal/intraday-scan", slot: "intraday-scan" },
  "quote-poll": { path: "/api/internal/pick-alerts", slot: "quote-poll" },
  sentinel: { path: "/api/internal/sentinel-ingest", slot: "sentinel" },
});

/**
 * The Sentinel feed of the recorded day, in the documented list shape (feed.ts asxFeedV1). The recorded
 * announcements of the fixtures are real text that never leaves the private repo, so the feed is one
 * invented announcement for a fake code (SEC-110), published a few minutes before the call.
 */
export function syntheticFeed(simIso) {
  const time = new Date(Date.parse(simIso) - 5 * 60_000).toISOString();
  return JSON.stringify({
    data: [
      {
        id: "RECORDED-DAY-1",
        code: "ZZA",
        time,
        type: "Announcement",
        price_sensitive: false,
        title: "Recorded day synthetic announcement",
        url: null,
      },
    ],
  });
}

/** The signed request for one route call: path, JSON body and v2 headers. Pure given its inputs. */
export function signedCall(name, { secret, nowSec, d, nonce, feed }) {
  const r = ROUTES[name];
  if (!r) throw new Error("unknown route");
  const base = {
    purpose: r.path.slice(r.path.lastIndexOf("/") + 1),
    env: "staging",
    d,
    slot: r.slot,
  };
  const body = JSON.stringify(
    name === "sentinel"
      ? { ...base, sha: sha256(feed ?? ""), feed: feed ?? "" }
      : { ...base, ...(r.extra ?? {}) },
  );
  const headers = {
    ...sign(secret, body, nowSec, nonce, { method: "POST", path: r.path }),
    "Content-Type": "application/json",
  };
  return { path: r.path, body, headers };
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ---- the plan -----------------------------------------------------------------------------------

/** Labels whose process must have written a guard marker (each guarded process of the plan). */
export function expectedLabels(plan) {
  return [...new Set(plan.filter((s) => s.guard).map((s) => s.label))].sort();
}

/**
 * Builds the ordered plan. Spawned steps run `node --import guard.mjs <script> <args>` (guard: true) or
 * a plain command (guard: false: the Next build, which makes no request). Function steps run in this
 * process, which has the guard installed itself (label `orchestrator`).
 * @returns {{ id: string, label: string, kind: "spawn"|"fn", guard: boolean, cmd?: string, args?: string[], at?: string, run?: Function }[]}
 */
export function buildPlan(cfg) {
  const { work, fixtures, tl } = cfg;
  const p = (f) => path.join(work, f);
  const node = (id, label, script, args, extra = {}) => ({
    id,
    label,
    kind: "spawn",
    guard: true,
    cmd: process.execPath,
    args: ["--import", GUARD_URL, script, ...args],
    ...extra,
  });
  const app = (phase) => ({
    id: `app-${phase.id}`,
    label: `app-${phase.id}`,
    kind: "fn",
    guard: true, // the app writes its own marker from instrumentation.ts
    at: phase.at,
    run: (ctx) => cfg.appPhase(phase, ctx),
  });
  const plan = [
    node("migrate-main", "migrate-main", "scripts/db/migrate.mjs", ["--db", "main"]),
    node("migrate-auth", "migrate-auth", "scripts/db/migrate.mjs", ["--db", "auth"]),
    { id: "seed", label: "orchestrator", kind: "fn", guard: false, run: cfg.seed },
    {
      id: "build",
      label: "build",
      kind: "spawn",
      guard: false,
      cmd: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "build:e2e"],
    },
    ...tl.morning.map(app),
    node("batch1-prepare", "batch1-prepare", "scripts/ingest/batch1.mjs", [
      "prepare",
      "--request",
      p("request.json"),
      "--now",
      tl.batch1,
    ]),
    node("recorded-source", "recorded-source", "scripts/ingest/recorded_day.mjs", [
      "--request",
      p("request.json"),
      "--fixtures",
      fixtures,
      "--date",
      cfg.recordedDate ?? "",
      "--output",
      p("bars.json"),
      "--index-output",
      p("index.json"),
      "--short-output",
      p("short.json"),
      "--actions-output",
      p("actions.json"),
      "--announcements-output",
      p("announcements.json"),
    ]),
    node("batch1-run", "batch1-run", "scripts/ingest/batch1.mjs", [
      "run",
      "--bars",
      p("bars.json"),
      "--index",
      p("index.json"),
      "--short",
      p("short.json"),
      "--actions",
      p("actions.json"),
      "--now",
      tl.batch1,
    ]),
    node("close-books", "close-books", "scripts/arena/close-books.mjs", [
      "--date",
      tl.date,
      "--wait-minutes",
      "1",
      "--now",
      tl.closeBooks,
    ]),
    node("signals", "signals", "scripts/arena/signals.mjs", [
      "--date",
      tl.date,
      "--wait-minutes",
      "1",
      "--now",
      tl.signals,
    ]),
    ...tl.evening.map(app),
  ];
  return plan;
}

/**
 * Runs the plan. Stops at the first failing step. `exec(step)` runs a spawned step and returns its exit code.
 * @returns {Promise<{ code: number, failed: string | null, ran: string[] }>}
 */
export async function runPlan(plan, { exec, out = (s) => console.log(s) }) {
  const ran = [];
  for (const step of plan) {
    ran.push(step.id);
    let code;
    try {
      code = step.kind === "spawn" ? await exec(step) : await step.run(step);
    } catch {
      code = 1;
    }
    const ok = code === 0 || code === true || code === undefined;
    out(`recorded-day: ${step.id} ${ok ? "ok" : "FAILED"}`);
    if (!ok) return { code: 1, failed: step.id, ran };
  }
  return { code: 0, failed: null, ran };
}

/** The final network assertion: no refusal, and every expected process wrote its marker. */
export function assertNetwork(logText, expected) {
  const { refused, markers } = parseNetLog(logText);
  const missing = expected.filter((l) => !markers.includes(l));
  const problems = [];
  if (refused > 0) problems.push(`${refused} request(s) to a non-loopback host were refused`);
  if (missing.length) problems.push(`no guard marker from: ${missing.join(", ")}`);
  return { ok: problems.length === 0, refused, missing, problems };
}

// ---- real runtime ------------------------------------------------------------------------------

function baseEnv(work, extra = {}) {
  const secrets = JSON.parse(readFileSync(path.join(work, "secrets.json"), "utf8"));
  const fileUrl = (n) => pathToFileURL(path.join(work, n)).href;
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    PRAXIS_ENV: "recorded",
    PRAXIS_NET_LOG: path.join(work, "net.log"),
    TURSO_MAIN_URL: fileUrl("main.db"),
    TURSO_AUTH_URL: fileUrl("auth.db"),
    AUTH_SECRET: secrets.auth,
    ACTIONS_HMAC_SECRET: secrets.actions,
    WORKER_HMAC_SECRET: secrets.worker,
    PII_HASH_KEY: secrets.pii,
    OWNER_EMAIL: "owner@praxis.test",
    APP_BASE_URL: `http://127.0.0.1:${PORT}`,
    EMAIL_PROVIDER: "mock",
    ...extra,
  };
}

function execStep(work) {
  return (step) =>
    new Promise((resolve) => {
      const child = spawn(step.cmd, step.args, {
        cwd: ROOT,
        env: baseEnv(work, { PRAXIS_NET_LABEL: step.label }),
        stdio: "inherit",
        shell: step.cmd.endsWith(".cmd"),
      });
      const timer = setTimeout(() => child.kill(), STEP_LIMIT_MS);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c ?? 1);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(1);
      });
    });
}

async function waitHealthy(deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** One app start at the simulated instant `phase.at`, its signed calls, the optional viewer walk. */
function appPhase(cfg) {
  return async (phase) => {
    const { work, tl } = cfg;
    const t0 = Date.now();
    const simStart = Date.parse(phase.at);
    const env = baseEnv(work, {
      PRAXIS_NET_LABEL: `app-${phase.id}`,
      PRAXIS_SIM_NOW: phase.at,
    });
    const server = spawn(
      process.execPath,
      [
        path.join(ROOT, "node_modules/next/dist/bin/next"),
        "start",
        "-p",
        String(PORT),
        "-H",
        "127.0.0.1",
      ],
      { cwd: ROOT, env, stdio: "ignore" },
    );
    try {
      if (!(await waitHealthy(Date.now() + HEALTH_WAIT_MS))) return 1;
      const secrets = JSON.parse(readFileSync(path.join(work, "secrets.json"), "utf8"));
      const feed = syntheticFeed(phase.at);
      for (const name of phase.calls) {
        const nowSec = Math.floor((simStart + (Date.now() - t0)) / 1000);
        const d = melbourneParts(simStart).date;
        const c = signedCall(name, {
          secret: secrets.worker,
          nowSec,
          d,
          nonce: randomBytes(16).toString("hex"),
          feed,
        });
        const res = await fetch(`http://127.0.0.1:${PORT}${c.path}`, {
          method: "POST",
          headers: c.headers,
          body: c.body,
          redirect: "manual",
          signal: AbortSignal.timeout(90_000),
        });
        const accepted = (cfg.accept[name] ?? [200]).includes(res.status);
        // The routes answer in fixed words (never the feed, a secret or a row): a short body is evidence.
        const word = (await res.text().catch(() => "")).replace(/[^\x20-\x7e]/g, "").slice(0, 160);
        console.log(
          `recorded-day: call ${name} HTTP ${res.status}${accepted ? "" : " (not accepted)"} ${word}`,
        );
        if (!accepted) return 1;
      }
      if (phase.walk) return await walk(work, phase.at, tl);
      return 0;
    } finally {
      server.kill();
      await new Promise((r) => setTimeout(r, 500));
    }
  };
}

function walk(work, simNow) {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", "--config", "playwright.day.config.ts"],
      {
        cwd: ROOT,
        env: baseEnv(work, {
          PRAXIS_NET_LABEL: "walk",
          PRAXIS_SIM_NOW: simNow,
          NODE_OPTIONS: `--import ${GUARD_URL}`,
        }),
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function seedDatabases({ work, fixtures, recordedDate, today }) {
  const fileUrl = (n) => pathToFileURL(path.join(work, n)).href;
  const main = createClient({ url: fileUrl("main.db") });
  const auth = createClient({ url: fileUrl("auth.db") });
  try {
    const now = new Date().toISOString();
    for (const [email, role] of [
      ["owner@praxis.test", "owner"],
      ["editor@praxis.test", "editor"],
      ["viewer@praxis.test", "viewer"],
    ]) {
      await auth.execute({
        sql: `INSERT OR IGNORE INTO app_user (email, name, role, status, created_at, updated_at)
              VALUES (?, ?, ?, 'active', ?, ?)`,
        args: [email, `Recorded ${role}`, role, now, now],
      });
    }
    // the trading date: the newest weekday up to today that the calendar does not mark a holiday
    let d = previousWeekday(today);
    for (let i = 0; i < 10; i++) {
      const r = await main.execute({
        sql: "SELECT kind FROM trading_calendar WHERE market = ? AND d = ?",
        args: [MARKET, d],
      });
      if (!r.rows.length || String(r.rows[0].kind) !== "holiday") break;
      d = previousWeekday(addDays(d, -1));
    }
    // calendar rows for the days around it, only where the seed has none (a holiday row is kept)
    for (let k = -12; k <= 4; k++) {
      const day = addDays(d, k);
      if (!isWeekday(day)) continue;
      await main.execute({
        sql: `INSERT OR IGNORE INTO trading_calendar (market, d, kind, close_time, confirmed, source)
              VALUES (?, ?, 'session', NULL, 1, 'recorded-day')`,
        args: [MARKET, day],
      });
    }
    await main.execute({ sql: "UPDATE market SET mode = 'full' WHERE code = ?", args: [MARKET] });
    // the production shape: the Owner has accepted the sources the day uses (DAT-120); nothing is fetched,
    // the recorded day serves their data
    await main.execute({
      sql: `UPDATE source_register SET status = 'enabled'
            WHERE source IN ('yahoo_eod', 'asx_announcements', 'yahoo_delayed')`,
      args: [],
    });
    // the production shape after go-live: dispatch on, e-mails full (the mock provider records them)
    for (const [key, value] of [
      ["dispatch_enabled", "1"],
      ["email_mode", "full"],
    ]) {
      await main.execute({
        sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
        args: [key, JSON.stringify(value), now],
      });
    }
    await main.execute({
      sql: `INSERT INTO go_live_signoff (market, signed_by, signed_at, release_commit, items_json, note, audit_ref)
            VALUES (?, 1, ?, ?, '[]', 'recorded day', 'audit:0')`,
      args: [MARKET, now, "0".repeat(40)],
    });
    // instruments of the recording (codes stay inside this temporary database and are never printed)
    const dir = path.join(path.resolve(fixtures), "recorded", "au", recordedDate);
    const bars = JSON.parse(readFileSync(path.join(dir, "bars.json"), "utf8"));
    const codes = [...new Set(bars.map((b) => String(b.code)))];
    for (const code of codes) {
      await main.execute({
        sql: `INSERT OR IGNORE INTO instrument (market, code, name, listed_on) VALUES (?, ?, ?, '2000-01-03')`,
        args: [MARKET, code, `Recorded ${code}`],
      });
    }
    console.log(`recorded-day: seed ok (instruments=${codes.length})`);
    return d;
  } finally {
    main.close();
    auth.close();
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, fixtures: null, work: null, date: null, from: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--fixtures") o.fixtures = rest[++i] ?? null;
    else if (a === "--work") o.work = rest[++i] ?? null;
    else if (a === "--date") o.date = rest[++i] ?? null;
    else if (a === "--from") o.from = rest[++i] ?? null;
    else return { error: "unknown option" };
  }
  if (!["run", "check", "assert-net"].includes(String(cmd)))
    return { error: "usage: run|check|assert-net" };
  if (!o.work) return { error: "--work is required" };
  if (cmd === "run" && !o.fixtures) return { error: "--fixtures is required" };
  if (o.date !== null && !DATE.test(o.date)) return { error: "--date must be YYYY-MM-DD" };
  return o;
}

/** @returns {Promise<number>} exit code */
export async function main(argv, env = process.env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const o = parseArgs(argv);
  if (o.error) {
    out(`recorded-day: ${o.error}`);
    return 2;
  }
  const work = path.resolve(o.work);
  if (o.cmd === "assert-net") {
    const logFile = path.join(work, "net.log");
    const planFile = path.join(work, "labels.json");
    if (!existsSync(logFile) || !existsSync(planFile)) {
      out("recorded-day: no network log (the run did not start)");
      return 1;
    }
    const r = assertNetwork(
      readFileSync(logFile, "utf8"),
      JSON.parse(readFileSync(planFile, "utf8")),
    );
    out(
      `recorded-day: network ${r.ok ? "ok" : "FAILED"} (refused=${r.refused}, missing markers=${r.missing.length})`,
    );
    for (const x of r.problems) out(`recorded-day: ${x}`);
    return r.ok ? 0 : 1;
  }
  if (o.cmd === "check") {
    const day = JSON.parse(readFileSync(path.join(work, "day.json"), "utf8"));
    const code = await (deps.exec ?? execStep(work))({
      kind: "spawn",
      label: "check",
      cmd: process.execPath,
      args: [
        "--import",
        GUARD_URL,
        "scripts/e2e-day/check.mjs",
        "--db",
        path.join(work, "main.db"),
        "--date",
        day.date,
        "--now",
        day.check,
        // the late sweep is a Worker-internal ASX job (disabled; the ASX Worker is off, PRD-047)
        "--except",
        "late_sweep",
      ],
    });
    return code === 0 ? 0 : 1;
  }

  // run
  mkdirSync(work, { recursive: true });
  const exec = deps.exec ?? execStep(work);
  const recordedDate = (await import("../../src/lib/data/recorded/reader.mjs")).findRecordedDate(
    o.fixtures,
    undefined,
  );
  const cfgRef = { work, fixtures: path.resolve(o.fixtures), recordedDate, seed: async () => 0 };
  const accept = {
    sentinel: [200],
    preopen: [200],
    "quote-poll": [200],
    "intraday-scan": [200],
    "evening-review": [200],
  };
  const guardEnv = { ...env, PRAXIS_ENV: "recorded", PRAXIS_NET_LOG: path.join(work, "net.log") };

  let plan;
  let first = [];
  if (o.from !== null) {
    // A local resume: the databases and secrets of an earlier run in this folder are reused.
    const day = JSON.parse(readFileSync(path.join(work, "day.json"), "utf8"));
    const tl = timeline(day.date);
    const full = buildPlan({
      ...cfgRef,
      tl,
      appPhase: (phase) => appPhase({ work, tl, accept })(phase),
    });
    const i = full.findIndex((x) => x.id === o.from);
    if (i < 0) {
      out("recorded-day: --from names no step");
      return 2;
    }
    plan = full.slice(i);
  } else {
    const secrets = { auth: HEX(), actions: HEX(), worker: HEX(), pii: HEX() };
    writeFileSync(path.join(work, "secrets.json"), JSON.stringify(secrets));
    writeFileSync(path.join(work, "net.log"), "");
    // The date is decided by the seed (it needs the migrated calendar), so the plan is built in two parts.
    const today = o.date ?? melbourneParts(Date.now()).date;
    first = buildPlan({ ...cfgRef, tl: timeline(previousWeekday(today)) }).slice(0, 2);
    installHostGuard(guardEnv);
    installNetGuard(guardEnv, net);
    writeGuardMarker(guardEnv, "orchestrator");
    const r1 = await runPlan(first, { exec, out });
    if (r1.code !== 0) return 1;
    const date = await seedDatabases({ work, fixtures: o.fixtures, recordedDate, today });
    const tl = timeline(date);
    writeFileSync(path.join(work, "day.json"), JSON.stringify({ date, check: tl.check }));
    plan = buildPlan({
      ...cfgRef,
      tl,
      appPhase: (phase) => appPhase({ work, tl, accept })(phase),
    }).slice(3); // migrate-main, migrate-auth and seed are done
  }
  if (o.from !== null) {
    installHostGuard(guardEnv);
    installNetGuard(guardEnv, net);
    writeGuardMarker(guardEnv, "orchestrator");
  }
  writeFileSync(
    path.join(work, "labels.json"),
    JSON.stringify(
      expectedLabels([
        ...first,
        ...plan,
        { guard: true, label: "check" },
        { guard: true, label: "walk" },
        { guard: true, label: "orchestrator" },
      ]),
    ),
  );
  const r = await runPlan(plan, { exec, out });
  return r.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    () => {
      console.log("recorded-day: stopped unexpectedly");
      process.exit(1);
    },
  );
}
