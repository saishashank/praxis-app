import { runSelfCheck, type SelfCheckEnv } from "./selfcheck";

export type Env = SelfCheckEnv;

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
    // Credential self-check (SEC-101): never throws; I/O waits only (PLT-070 CPU budget).
    await runSelfCheck(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
