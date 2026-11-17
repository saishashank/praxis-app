// The one seam every night-time CLI takes its routers from (M22 A2, D-1401, D-1445). Today it is rules-only: no provider is
// built, no key is read and no request is made; every call is answered from its template and logged as a rules-only row
// (LLM-040: no role has a live model before its bake-off passes). Task L1 points this file at the live factory, which stays
// the only place that may build a live provider (LLM-077). The CLIs shape the result to their own phase types.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { Role } from "./budget";
import type { LlmProvider } from "./providers";
import { createRouter, type LlmRouter } from "./router";
import { DbStore, type LlmStore } from "./store";

export type NightCtx = { db: Client; params: AgentParams; kbVersion: string };

export type NightLlm = {
  /** A router for one role; each call returns a fresh router (its own cool-down state), all over the same call log. */
  readonly routerFor: (role: Role) => LlmRouter;
  /** The providers the routers use: none while rules-only. */
  readonly providers: readonly LlmProvider[];
  /** The call log the budget reservations read (the store the routers write to). */
  readonly store: LlmStore;
};

/** Rules-only routers over the database call log (the default until a bake-off passes, LLM-040). */
export function nightlyLlm(ctx: NightCtx): NightLlm {
  const store = new DbStore(ctx.db);
  return {
    routerFor: () =>
      createRouter({
        mode: "rules-only",
        params: ctx.params.llm,
        kbVersion: ctx.kbVersion,
        store,
        providers: [],
      }),
    providers: [],
    store,
  };
}
