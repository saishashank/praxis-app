import { runAsx, type AsxEnv } from "./asx/slots";
import { runUniverse, type UniverseEnv } from "./asx/universe";
import { runClock } from "./clock";
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
    // Master clock (PLT-071): dispatches due workflows. Never throws; no work on idle minutes.
    try {
      await runClock(env, controller.scheduledTime, {
        fetch: (i, init) => fetch(i, init),
        nowMs: () => Date.now(),
      });
    } catch {
      // runClock already contains its errors; nothing here may disturb the self-check.
    }
    // Signed route slots (M5 T10, decision 41): alert flush, pre-open, Evening Review. All slots are
    // disabled; no work and no database request unless one is enabled and due. Never throws.
    try {
      await runRoutes(env, controller.scheduledTime, {
        fetch: (i, init) => fetch(i, init),
        nowMs: () => Date.now(),
      });
    } catch {
      // runRoutes already contains its errors.
    }
    // ASX poll (DAT-122): zero database work unless ASX_LIVE is on, a poll slot is due and the
    // environment is production; the token and kill switch decide the rest. Never throws.
    try {
      await runAsx(env, controller.scheduledTime, {
        fetch: (i, init) => fetch(i, init),
        nowMs: () => Date.now(),
      });
    } catch {
      // runAsx already contains its errors.
    }
    // ASX listed-companies import (D-067): one trading-day slot at 07:30 Sydney; the same
    // switches as the poll and the same rate token (priority 3). Never throws.
    try {
      await runUniverse(env, controller.scheduledTime, {
        fetch: (i, init) => fetch(i, init),
        nowMs: () => Date.now(),
      });
    } catch {
      // runUniverse already contains its errors.
    }
    // Credential self-check (SEC-101): never throws; I/O waits only (PLT-070 CPU budget).
    await runSelfCheck(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
