// The one seam every night-time CLI takes its routers from (M22 A2, D-1401, D-1445; pointed at the factory by L1, D-1459).
// It builds nothing itself: the routers and providers come from `factory.ts`, the only place that may build a live provider
// (LLM-077). A role is live only when `llm_live_roles` lists it, its bake-off passed and its key is present; otherwise the
// router is the rules-only one (every call answered from its template and logged as a rules-only row, LLM-040). A caller
// that does not pass `liveRoles` (or passes null) gets rules-only everywhere: the list is read by `loadNightLlm`.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { Role } from "./budget";
import {
  liveRoutes,
  readLiveRoles,
  type FactoryCtx,
  type ProviderSelect,
  type RoutesStatus,
} from "./factory";
import type { LlmProvider } from "./providers";
import type { LlmRouter } from "./router";
import { DbStore, type LlmStore } from "./store";

export type NightCtx = {
  db: Client;
  params: AgentParams;
  kbVersion: string;
  /** `llm_live_roles` as read by `readLiveRoles`; absent or null keeps every role rules-only. */
  liveRoles?: readonly string[] | null;
  /** Test seams: environment, fetch, bake-off index and roster of the factory. */
  env?: FactoryCtx["env"];
  fetchImpl?: FactoryCtx["fetchImpl"];
  index?: FactoryCtx["index"];
  roster?: FactoryCtx["roster"];
};

export type NightLlm = {
  /** A router for one role; each call returns a fresh router (its own cool-down state), all over the same call log. */
  readonly routerFor: (role: Role, select?: ProviderSelect) => LlmRouter;
  /** The providers the routers use: none while rules-only. */
  readonly providers: readonly LlmProvider[];
  /** The call log the budget reservations read (the store the routers write to). */
  readonly store: LlmStore;
  /** Where each role stands and why (the same decision the routers were built from). */
  readonly status: RoutesStatus;
};

/** The night's routers from the factory (rules-only unless `ctx.liveRoles` lists a role that may go live). */
export function nightlyLlm(ctx: NightCtx): NightLlm {
  const store = new DbStore(ctx.db);
  const routes = liveRoutes({
    params: ctx.params,
    kbVersion: ctx.kbVersion,
    store,
    liveRoles: ctx.liveRoles,
    env: ctx.env,
    fetchImpl: ctx.fetchImpl,
    index: ctx.index,
    roster: ctx.roster,
  });
  return {
    routerFor: (role, select) => routes.routerOf(role, select).router,
    providers: routes.providers,
    store,
    status: routes.status,
  };
}

/** `nightlyLlm` after reading `llm_live_roles` (a failed read keeps every role rules-only). */
export async function loadNightLlm(ctx: NightCtx): Promise<NightLlm> {
  return nightlyLlm({ ...ctx, liveRoles: await readLiveRoles(ctx.db) });
}
