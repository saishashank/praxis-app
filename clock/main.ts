// Process entry points of praxis-clock (INFRA T3). Bundled and started by `clock/index.mjs` (the TypeScript
// is bundled at start-up with Vite exactly like scripts/arena/engine.mjs, no extra loader).
//   main()      the daemon: health server on :9100, a tick every 30 s, graceful stop on SIGTERM.
//   runJobCli() `praxis run <job> [--input k=v]`: one job in this process, same lease and runner.
import path from "node:path";
import { startHealthServer } from "./health";
import { createClock, type Clock } from "./loop";
import { allJobs, loadManifest, type Manifest } from "./manifest";

export const TICK_EVERY_MS = 30_000;
export const MONITOR_EVERY_MS = 30_000;
export const STOP_WAIT_MS = 50_000;

const manifestPath = (env: Record<string, string | undefined>): string =>
  path.resolve(env.JOBS_MANIFEST ?? path.join("deploy", "selfhost", "jobs.json"));

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const manifest = loadManifest(manifestPath(env));
  const clock = createClock({ rawEnv: env, manifest });
  const port = Number(env.CLOCK_HEALTH_PORT ?? 9100);
  const server = await startHealthServer(port, clock.health, clock.runner);
  console.log(
    `clock: up (runtime=${clock.health.runtime}, enabled=${clock.health.enabled}, jobs=${allJobs(manifest).length})`,
  );
  let timer: NodeJS.Timeout | undefined;
  let monitorTimer: NodeJS.Timeout | undefined;
  if (clock.health.enabled) {
    await clock.recover();
    await clock.selfCheck();
    const safeTick = (): void => {
      clock.tick().catch(() => console.log("clock: tick failed"));
    };
    safeTick();
    timer = setInterval(safeTick, TICK_EVERY_MS);
    // INFRA T6: dead-man ping, host checks, idle trend. The monitor never throws and schedules itself.
    await clock.monitor.init();
    const safeMonitor = (): void => {
      void clock.monitor.step();
    };
    safeMonitor();
    monitorTimer = setInterval(safeMonitor, MONITOR_EVERY_MS);
  } else {
    console.log("clock: CLOCK_ENABLED=0, nothing is read; serving health only");
  }
  const stop = (sig: string): void => {
    console.log(`clock: ${sig}, stopping`);
    if (timer) clearInterval(timer);
    if (monitorTimer) clearInterval(monitorTimer);
    const hardStop = setTimeout(() => process.exit(0), STOP_WAIT_MS);
    hardStop.unref();
    clock.runner.idle().finally(() => server.close(() => process.exit(0)));
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

/** `praxis run`: returns the process exit code (0 success, 1 failed or timeout, 2 usage, 3 blocked). */
export async function runJobCli(
  env: Record<string, string | undefined>,
  job: string,
  inputs: Record<string, string>,
): Promise<number> {
  const manifest: Manifest = loadManifest(manifestPath(env));
  const clock: Clock = createClock({ rawEnv: env, manifest });
  const res = await clock.runner.runNow({ job, slotId: "manual", inputs });
  if (res.status === "unknown-job") {
    console.log(
      `unknown job: ${job} (known: ${allJobs(manifest)
        .map(([n]) => n)
        .join(", ")})`,
    );
    return 2;
  }
  if (res.status === "blocked") {
    console.log(
      `not started: ${job} (or a job of its group) is already running; see: praxis status`,
    );
    return 3;
  }
  console.log(`run ${res.id}: ${res.status}`);
  return res.status === "success" ? 0 : 1;
}
