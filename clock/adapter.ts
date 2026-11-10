// Adapter between the clock loop and the Worker's runners (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §4, §5.1).
// `runWorkerRunners` is `scheduled()` of worker/src/index.ts, minute for minute: the same runners, the same
// concurrent chains, the same "never throws". The runners are not reimplemented; they read the slot table,
// the owner key and the run records themselves, and gate on `worker_state.clock_owner` (INFRA T1).
//
// Left out on purpose (they belong to the Cloudflare Worker and have no meaning here):
//  - runReenable: re-enables GitHub `schedule:` workflows that GitHub switched off after 60 days. The clock
//    is not a GitHub schedule, and its dispatch token only reaches replay.yml.
//  - runSelfCheck: the Worker's daily credential report. Replaced by the health endpoint and the start-up
//    self-check of the clock (clock/health.ts, clock/loop.ts `selfCheck`).
import { runAsx } from "../worker/src/asx/slots";
import { runUniverse } from "../worker/src/asx/universe";
import { runClock } from "../worker/src/clock";
import { runPostDeploy } from "../worker/src/postdeploy";
import { runRoutes } from "../worker/src/routes";
import { runRunNow } from "../worker/src/runNow";
import type { TickEnv } from "./env";

export type WorkerDeps = { fetch: typeof fetch; nowMs: () => number };

/** One tick of every Worker runner for the minute `scheduledTime` (epoch ms, start of the minute). */
export async function runWorkerRunners(
  env: TickEnv,
  scheduledTime: number,
  deps: WorkerDeps,
): Promise<void> {
  const guarded = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      // every runner already contains its own errors; nothing here may disturb the others.
    }
  };
  await Promise.all([
    // Master clock (PLT-071): dispatches due workflows (here: queues local jobs through the fetch shim).
    guarded(() => runClock(env, scheduledTime, deps)),
    // D-195: the first tick of a newly deployed commit dispatches the post-deploy fill once.
    guarded(() => runPostDeploy(env, deps)),
    // Signed route slots (M5 T10, decision 41).
    guarded(() => runRoutes(env, scheduledTime, deps)),
    // Owner "Run now" requests (D-840).
    guarded(() => runRunNow(env, scheduledTime, deps)),
    // ASX poll (DAT-122), then the listed-companies import (D-067): serial, they share the token.
    guarded(async () => {
      await guarded(() => runAsx(env, scheduledTime, deps));
      await guarded(() => runUniverse(env, scheduledTime, deps));
    }),
  ]);
}
