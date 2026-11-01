import { runAsx, type AsxEnv } from "./asx/slots";
import { runUniverse, type UniverseEnv } from "./asx/universe";
import { runClock } from "./clock";
import { runPostDeploy } from "./postdeploy";
import { runReenable } from "./reenable";
import { runRoutes, type RouteEnv } from "./routes";
import { runSelfCheck, type SelfCheckEnv } from "./selfcheck";

export type Env = SelfCheckEnv & AsxEnv & UniverseEnv & RouteEnv;

export interface Heartbeat {
  kind: "heartbeat";
  at: string;
  env: string;
}

export function heartbeat(scheduledTime: number, envName: string): Heartbeat {
  return { kind: "heartbeat", at: new Date(scheduledTime).toISOString(), env: envName };
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    console.log(JSON.stringify(heartbeat(controller.scheduledTime, env.PRAXIS_ENV)));
    const deps = {
      fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, init),
      nowMs: () => Date.now(),
    };
    // V1-I8 (D-774): the runners are independent (each reads and claims its own rows, every one is
    // idempotent and never throws), so they run as concurrent chains instead of one after another:
    // the worst minute is the slowest chain (one route post, up to 28 s) rather than the sum, which
    // could pass 60 s. The ASX poll and the listed-companies import share ONE rate token (priority
    // 3), so they stay in one serial chain. CPU time and the subrequest count are unchanged (the same
    // work); at most five requests are in flight, inside the six-connection limit.
    const guarded = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch {
        // every runner already contains its own errors; nothing here may disturb the others.
      }
    };
    await Promise.all([
      // Master clock (PLT-071): dispatches due workflows. Never throws; no work on idle minutes.
      guarded(() => runClock(env, controller.scheduledTime, deps)),
      // D-195: the first tick of a newly deployed commit dispatches the post-deploy fill once.
      guarded(() => runPostDeploy(env, deps)),
      // PLT-015: once a day (02:40-02:44 UTC) re-enable scheduled workflows GitHub disabled.
      guarded(() => runReenable(env, controller.scheduledTime, deps)),
      // Signed route slots (M5 T10, decision 41): no work and no database request unless one is due.
      guarded(() => runRoutes(env, controller.scheduledTime, deps)),
      // ASX poll (DAT-122), then the listed-companies import (D-067): serial, they share the token.
      guarded(async () => {
        await guarded(() => runAsx(env, controller.scheduledTime, deps));
        await guarded(() => runUniverse(env, controller.scheduledTime, deps));
      }),
      // Credential self-check (SEC-101): I/O waits only (PLT-070 CPU budget).
      guarded(() => runSelfCheck(env, controller.scheduledTime)),
    ]);
  },
} satisfies ExportedHandler<Env>;
