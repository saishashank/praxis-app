// The one live-route factory (M22 L1, LLM-077, LLM-080, D-1401, D-1408). The only module of the app that may turn a roster
// model into a live provider (tests/security/liveProviderSites.test.ts). A role gets a live chain only when ALL hold:
//   - the role (or `words` for the wording roles R3 and R5, D-1402) is in `llm_live_roles`;
//   - the bake-off index records a PASS for it, newest report wins (D-1403);
//   - each chain model passed in that report, is routable in the roster, does not train on prompts, is a tier the role may
//     use (D-1408), has a live adapter and is not a paid route;
//   - its provider key is present.
// Anything else, and any read error, returns the rules-only router and ONE reason. Fails closed everywhere: a missing
// piece never widens a route, and nothing here reads a key's value (the adapter reads it at call time).
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import { getConfig } from "@/lib/config/store";
import type { Role } from "./budget";
import { BAKEOFF_INDEX, type RoleVerdict } from "./bakeoffIndex.generated";
import { providerForRoster, type LlmProvider } from "./providers";
import { createRouter, type LlmRouter } from "./router";
import {
  gateOf,
  ROLE_TIERS,
  ROLE_WORDS,
  ROSTER,
  TIER_RANK,
  type GateRole,
  type ModelTier,
  type RosterEntry,
} from "./roster";
import type { LlmStore } from "./store";

export type RouteReason =
  "not_listed" | "bakeoff_not_passed" | "model_not_routable" | "no_key" | "config_unreadable";

export const ROUTE_ROLES: readonly Role[] = ["R1", "R2", "R3", "R5", "R6", "R7"];

export type FactoryCtx = {
  params: AgentParams;
  kbVersion: string;
  /** The call log every router writes to and the budget reads. */
  store: LlmStore;
  /** `llm_live_roles` as read; null (or absent) = unreadable, which keeps every role rules-only. */
  liveRoles: readonly string[] | null | undefined;
  /** The bake-off index; defaults to the generated one (tests pass their own). */
  index?: Readonly<Partial<Record<GateRole, RoleVerdict>>>;
  /** The roster; defaults to the real one (tests pass their own). */
  roster?: readonly RosterEntry[];
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
};

export type RouteModel = { provider: string; modelId: string; tier: ModelTier };

export type RoleRoute = {
  role: Role;
  gate: GateRole | null;
  live: boolean;
  /** Why the role is rules-only; null when live. */
  reason: RouteReason | null;
  /** The chain, cheapest tier first (empty when rules-only). */
  models: readonly RouteModel[];
  /** The role is in the list but only its words switch counts (R3 or R5 listed without `words`). */
  listedAlone: boolean;
};

export type RoutesStatus = {
  liveRoles: readonly string[] | null;
  roles: readonly RoleRoute[];
};

const asList = (v: unknown): readonly string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

/** `llm_live_roles` from the configuration store; null when it cannot be read or is not a list of names. */
export async function readLiveRoles(
  db: Pick<Client, "execute">,
): Promise<readonly string[] | null> {
  try {
    return asList(await getConfig(db, "llm_live_roles"));
  } catch {
    return null;
  }
}

const keyAvailable = (p: LlmProvider): boolean => {
  try {
    return p.available();
  } catch {
    return false;
  }
};

type Candidate = { entry: RosterEntry; tier: ModelTier; order: number };

type Plan = RoleRoute & { candidates: readonly Candidate[] };

function plan(role: Role, ctx: FactoryCtx, opts: { checkKeys: boolean }): Plan {
  const gate = gateOf(role);
  const none = (reason: RouteReason, listedAlone = false): Plan => ({
    role,
    gate,
    live: false,
    reason,
    models: [],
    listedAlone,
    candidates: [],
  });
  if (!ctx.liveRoles || !Array.isArray(ctx.liveRoles)) return none("config_unreadable");
  if (gate === null) return none("not_listed");
  const listed = ctx.liveRoles.includes(gate);
  if (!listed) return none("not_listed", ctx.liveRoles.includes(role) && role !== gate);
  const verdict = (ctx.index ?? BAKEOFF_INDEX)[gate];
  if (!verdict || verdict.verdict !== "PASS" || verdict.models.length === 0)
    return none("bakeoff_not_passed");
  const roster = ctx.roster ?? ROSTER;
  const allowed = ROLE_TIERS[role] ?? [];
  const env = ctx.env ?? process.env;
  const candidates: Candidate[] = [];
  roster.forEach((entry, order) => {
    if (!verdict.models.includes(entry.modelId)) return;
    if (entry.status === "retired" || entry.modelId === "*") return;
    if (entry.trainsOnPrompts !== false) return;
    const tier = entry.tier;
    if (tier === null || !allowed.includes(tier)) return;
    // a model the adapters cannot serve (no adapter, or a paid route) is not routable
    const probe = providerForRoster(entry.provider, {
      models: { [role]: entry.modelId },
      trainsOnPrompts: false,
      env,
    });
    if (probe === null || probe.paid) return;
    candidates.push({ entry, tier, order });
  });
  if (candidates.length === 0) return none("model_not_routable");
  candidates.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.order - b.order);
  const ready = opts.checkKeys
    ? candidates.filter((c) => {
        const p = providerForRoster(c.entry.provider, {
          models: { [role]: c.entry.modelId },
          trainsOnPrompts: false,
          env,
        });
        return p !== null && keyAvailable(p);
      })
    : candidates;
  if (ready.length === 0) return none("no_key");
  return {
    role,
    gate,
    live: true,
    reason: null,
    models: ready.map((c) => ({
      provider: c.entry.provider,
      modelId: c.entry.modelId,
      tier: c.tier,
    })),
    listedAlone: false,
    candidates: ready,
  };
}

/**
 * Where every role stands, with no provider built and no request made. `checkKeys: false` is for the health line, which is
 * computed where the keys do not live (they are set only in the nightly job, D-1412): a missing key is then not reported.
 */
export function routesStatus(
  ctx: Pick<FactoryCtx, "liveRoles" | "index" | "roster" | "env">,
  opts: { checkKeys?: boolean } = {},
): RoutesStatus {
  const full = ctx as FactoryCtx;
  const roles = ROUTE_ROLES.map((r) => {
    const { candidates: _c, ...route } = plan(r, full, { checkKeys: opts.checkKeys ?? true });
    void _c;
    return route;
  });
  return { liveRoles: ctx.liveRoles ?? null, roles };
}

export type RouterChoice = { router: LlmRouter; route: RoleRoute };

/** A restriction of the chain by provider id (M22 L4, D-1466): only this one, and/or none of these. */
export type ProviderSelect = { readonly only?: string; readonly avoid?: readonly string[] };

export type NightRoutes = {
  /** A fresh router per call (its own cool-down state), all over the same call log; `select` narrows its chain by provider id. */
  routerOf: (role: Role, select?: ProviderSelect) => RouterChoice;
  /** Every live provider of the night (shared by the routers); empty while rules-only. */
  providers: readonly LlmProvider[];
  status: RoutesStatus;
};

/**
 * All six roles at once, so one model serves every role that uses it through one provider instance. The provider id is the
 * provider name when the night uses one model of that provider, else `provider:model` (the router chain is by id).
 */
export function liveRoutes(ctx: FactoryCtx): NightRoutes {
  const env = ctx.env ?? process.env;
  const plans = new Map<Role, Plan>(ROUTE_ROLES.map((r) => [r, plan(r, ctx, { checkKeys: true })]));
  const models = new Map<string, { entry: RosterEntry; roles: Set<Role> }>();
  for (const p of plans.values()) {
    for (const c of p.candidates) {
      const key = `${c.entry.provider}\u0000${c.entry.modelId}`;
      const hit = models.get(key) ?? { entry: c.entry, roles: new Set<Role>() };
      hit.roles.add(p.role);
      models.set(key, hit);
    }
  }
  const perProvider = new Map<string, number>();
  for (const { entry } of models.values())
    perProvider.set(entry.provider, (perProvider.get(entry.provider) ?? 0) + 1);
  const idOf = (entry: RosterEntry): string =>
    perProvider.get(entry.provider) === 1 ? entry.provider : `${entry.provider}:${entry.modelId}`;
  const providers = new Map<string, LlmProvider>();
  for (const [key, { entry, roles }] of models) {
    const built = providerForRoster(entry.provider, {
      id: idOf(entry),
      models: Object.fromEntries([...roles].map((r) => [r, entry.modelId])),
      trainsOnPrompts: false,
      env,
      fetchImpl: ctx.fetchImpl,
    });
    if (built !== null) providers.set(key, built);
  }
  const status: RoutesStatus = {
    liveRoles: ctx.liveRoles ?? null,
    roles: ROUTE_ROLES.map((r) => {
      const { candidates: _c, ...route } = plans.get(r)!;
      void _c;
      return route;
    }),
  };
  const routerOf = (role: Role, select?: ProviderSelect): RouterChoice => {
    const p = plans.get(role)!;
    const { candidates, ...route } = p;
    const chain = candidates
      .flatMap((c) => {
        const prov = providers.get(`${c.entry.provider}\u0000${c.entry.modelId}`);
        return prov ? [prov] : [];
      })
      .filter(
        (prov) =>
          (select?.only === undefined || prov.id === select.only) &&
          !(select?.avoid ?? []).includes(prov.id),
      );
    if (!route.live || chain.length === 0) {
      return {
        route:
          chain.length === 0 && route.live
            ? { ...route, live: false, reason: "model_not_routable", models: [] }
            : route,
        router: createRouter({
          mode: "rules-only",
          params: ctx.params.llm,
          kbVersion: ctx.kbVersion,
          store: ctx.store,
          providers: [],
        }),
      };
    }
    return {
      route,
      router: createRouter({
        mode: "live",
        params: ctx.params.llm,
        kbVersion: ctx.kbVersion,
        store: ctx.store,
        providers: chain,
        chain: { [role]: chain.map((x) => x.id) },
      }),
    };
  };
  return { routerOf, providers: [...providers.values()], status };
}

/** One role's router and its route (the rules-only router with a reason unless every condition holds). */
export function routerFor(role: Role, ctx: FactoryCtx): RouterChoice {
  return liveRoutes(ctx).routerOf(role);
}

/** The plain word of a role for an Owner-read text (D-1402). */
export const roleWord = (role: string): string => ROLE_WORDS[role] ?? "this task";
