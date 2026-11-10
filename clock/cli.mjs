// Operator CLI of the self-hosted runtime (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.5). Run inside the clock
// container by `deploy/selfhost/bin/praxis` (docker compose exec clock node clock/cli.mjs ...).
//   status                       health of the clock and the newest job runs
//   run <job> [--input k=v ...]  run one job now (same lease and runner as the clock)
//   logs <job|run-id>            print the log of a run (the newest run of a job)
//   owner [cloud|selfhost]       show, or switch, the clock owner (ONE database write), then print the
//                                last-tick times of both clocks
//   backup-now                   run the backup job now (repo copy, then the bucket copy)
//   restore-drill [--source live|synthetic|backup]   run the restore drill job now
//   restore-latest               newest backup into sqld, then migrate (BACKUP_PRIVATE_KEY supplied per command)
//   deploy, switch               host commands (deploy.sh, switch.sh), not run here: print a pointer, exit 2
// The commands other than `run` use plain fetch and need no bundle, so they answer at once. No secret is
// printed: the database URL and token are read from the environment and used, never shown.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const OWNER_KEY = "clock_owner";
// `deploy` drives docker compose, so it is a host command (deploy/selfhost/deploy.sh); the wrapper never sends it here.
const HOST_ONLY = { deploy: true, switch: true };

const env = process.env;

/** Pipeline client for the main database (Turso or sqld, hrana over http). */
async function pipe(stmts) {
  const url = (env.TURSO_MAIN_URL ?? "").trim().replace(/^libsql:/, "https:");
  const token = (env.TURSO_MAIN_TOKEN ?? "").trim();
  if (!url || !token) throw new Error("TURSO_MAIN_URL / TURSO_MAIN_TOKEN are not set");
  const arg = (a) =>
    a === null || a === undefined
      ? { type: "null" }
      : typeof a === "number"
        ? { type: "integer", value: String(a) }
        : { type: "text", value: String(a) };
  const res = await fetch(`${url.replace(/\/$/, "")}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        ...stmts.map((s) => ({
          type: "execute",
          stmt: { sql: s.sql, args: (s.args ?? []).map(arg) },
        })),
        { type: "close" },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`database answered HTTP ${res.status}`);
  const json = await res.json();
  return stmts.map((_, i) => {
    const r = json.results?.[i];
    if (r?.type !== "ok") throw new Error("database statement failed");
    return (r.response?.result?.rows ?? []).map((row) =>
      row.map((c) => (c.type === "null" ? null : c.type === "integer" ? Number(c.value) : c.value)),
    );
  });
}

const ownerOf = (valueJson) => {
  try {
    return JSON.parse(valueJson) === "selfhost" ? "selfhost" : "cloud";
  } catch {
    return "cloud";
  }
};

async function health() {
  const port = env.CLOCK_HEALTH_PORT ?? "9100";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function lastTicks() {
  const [tick, wState, wRec] = await pipe([
    {
      sql: "SELECT value_json, updated_at FROM worker_state WHERE key = ?",
      args: ["clock_tick:selfhost"],
    },
    { sql: "SELECT max(updated_at) FROM worker_state WHERE key LIKE 'slot:%'" },
    { sql: "SELECT max(started_at) FROM run_record WHERE job = 'worker-clock'" },
  ]);
  const cloud = [wState[0]?.[0], wRec[0]?.[0]].filter(Boolean).sort().pop() ?? "none recorded";
  return {
    selfhost: tick[0]?.[1] ?? "none recorded",
    cloud: `${cloud} (newest slot claim or daily record; the Worker keeps no per-minute record)`,
  };
}

function printTicks(t) {
  console.log(`last tick  selfhost clock: ${t.selfhost}`);
  console.log(`last tick  cloud Worker:   ${t.cloud}`);
}

async function status() {
  const h = await health();
  if (h) {
    console.log(
      `clock: ${h.ok ? "ok" : "NOT OK"}  owner=${h.owner ?? "unknown"}  enabled=${h.enabled}  last tick=${h.lastTick ?? "never"}`,
    );
    console.log(
      `running: ${h.running.length ? h.running.map((r) => `${r.job}#${r.id}`).join(", ") : "none"}  queued: ${h.queued}`,
    );
    if (h.lastError) console.log(`last error: ${h.lastError.what} at ${h.lastError.at}`);
  } else {
    console.log("clock: health endpoint not reachable");
  }
  const [rows] = await pipe([
    {
      sql: "SELECT id, job, status, local_date, started_at, exit_code FROM job_run ORDER BY id DESC LIMIT 10",
    },
  ]);
  console.log("newest runs:");
  for (const r of rows)
    console.log(
      `  #${r[0]}  ${r[1]}  ${r[2]}  ${r[3]}  started ${r[4]}${r[5] === null ? "" : `  exit ${r[5]}`}`,
    );
  if (rows.length === 0) console.log("  none");
}

async function owner(arg) {
  if (arg === undefined) {
    const [r] = await pipe([
      { sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [OWNER_KEY] },
    ]);
    console.log(`owner: ${r[0] ? ownerOf(r[0][0]) : "cloud (key absent)"}`);
    printTicks(await lastTicks());
    return 0;
  }
  if (arg !== "cloud" && arg !== "selfhost") {
    console.log("usage: praxis owner [cloud|selfhost]");
    return 2;
  }
  const at = new Date().toISOString();
  await pipe([
    {
      sql:
        "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      args: [OWNER_KEY, JSON.stringify(arg), at],
    },
  ]);
  console.log(
    `owner set to ${arg} at ${at}. The other clock goes to standby on its next tick (within a minute).`,
  );
  printTicks(await lastTicks());
  return 0;
}

async function logs(target) {
  if (!target) {
    console.log("usage: praxis logs <job|run-id>");
    return 2;
  }
  const byId = /^\d+$/.test(target);
  const [rows] = await pipe([
    byId
      ? { sql: "SELECT id, log_path FROM job_run WHERE id = ?", args: [Number(target)] }
      : {
          sql: "SELECT id, log_path FROM job_run WHERE job = ? ORDER BY id DESC LIMIT 1",
          args: [target],
        },
  ]);
  if (rows.length === 0) {
    console.log(`no run found for ${target}`);
    return 1;
  }
  const [id, path] = rows[0];
  if (!path) {
    console.log(`run ${id} has no log file`);
    return 1;
  }
  try {
    process.stdout.write(readFileSync(path, "utf8"));
  } catch {
    console.log(`log file of run ${id} is gone (logs are kept 14 days)`);
    return 1;
  }
  return 0;
}

/** `praxis restore-latest`: newest backup into (empty) sqld, then the migrations on top. Stops at the first failure. */
function restoreLatest() {
  const steps = [
    ["scripts/selfhost/latest-backup.mjs", "--db", "both", "--restore"],
    ["scripts/db/migrate.mjs", "--db", "main", "--target", "sqld"],
    ["scripts/db/migrate.mjs", "--db", "auth", "--target", "sqld"],
  ];
  for (const args of steps) {
    console.log(`restore-latest: ${args[0]} ${args.slice(1).join(" ")}`);
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
    if (r.status !== 0) {
      console.log(`restore-latest: stopped, ${args[0]} exited with ${r.status}`);
      return r.status ?? 1;
    }
  }
  console.log("restore-latest: done");
  return 0;
}

async function run(rest) {
  const job = rest[0];
  if (!job || job.startsWith("-")) {
    console.log("usage: praxis run <job> [--input k=v ...]");
    return 2;
  }
  const inputs = {};
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] !== "--input" || !/^[a-z_]+=/.test(rest[i + 1] ?? "")) {
      console.log("usage: praxis run <job> [--input k=v ...]");
      return 2;
    }
    const kv = rest[++i];
    inputs[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
  }
  const { loadEngine } = await import("../scripts/arena/engine.mjs");
  const entry = await loadEngine("clock/main.ts");
  return entry.runJobCli(process.env, job, inputs);
}

const [cmd, ...rest] = process.argv.slice(2);
let code = 0;
try {
  if (cmd === "status") await status();
  else if (cmd === "owner") code = await owner(rest[0]);
  else if (cmd === "logs") code = await logs(rest[0]);
  else if (cmd === "run" && rest[0] === "logs") code = await logs(rest[1]);
  else if (cmd === "run") code = await run(rest);
  else if (cmd === "backup-now") code = await run(["backup"]);
  else if (cmd === "restore-drill") {
    const src = rest[0] === "--source" ? rest[1] : undefined;
    if (rest.length > 0 && (src === undefined || rest.length !== 2)) {
      console.log("usage: praxis restore-drill [--source live|synthetic|backup]");
      code = 2;
    } else {
      code = await run(
        src === undefined ? ["restore-drill"] : ["restore-drill", "--input", `source=${src}`],
      );
    }
  } else if (cmd === "restore-latest") code = restoreLatest();
  else if (cmd in HOST_ONLY) {
    console.log(`${cmd} runs on the host, not in the clock container: use "praxis ${cmd}" there`);
    code = 2;
  } else {
    console.log(
      "usage: praxis status | run <job> [--input k=v] | logs <job|run-id> | owner [cloud|selfhost]",
    );
    console.log(
      "       praxis backup-now | restore-drill [--source s] | restore-latest | deploy <sha> | switch (the last two run on the host)",
    );
    code = 2;
  }
} catch (e) {
  console.log(`failed: ${e instanceof Error ? e.message : "error"}`);
  code = 1;
}
process.exit(code);
