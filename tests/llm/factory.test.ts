// @vitest-environment node
// M22 L1 (LLM-077, LLM-080, D-1401, D-1408): the live-route factory. A role is live only when it is listed, the bake-off
// index records a PASS, the model passed, is routable, does not train on prompts, is an allowed tier, and its key is
// present; anything else is the rules-only router with one reason. Fetch is a spy: nothing here reaches a network.
import { describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import type { Role } from "@/lib/llm/budget";
import { buildIndex } from "../../scripts/llm/bakeoff-index.mjs";
import type { RoleVerdict } from "@/lib/llm/bakeoffIndex.generated";
import {
  liveRoutes,
  readLiveRoles,
  routerFor,
  routesStatus,
  type FactoryCtx,
  type RouteReason,
} from "@/lib/llm/factory";
import {
  gateOf,
  ROLE_TIERS,
  ROLE_WORDS,
  ROSTER,
  TIER_RANK,
  type GateRole,
  type RosterEntry,
} from "@/lib/llm/roster";
import { MemoryStore } from "@/lib/llm/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { fixture, request } from "./helpers";

const entry = (
  over: Partial<RosterEntry> & Pick<RosterEntry, "provider" | "modelId">,
): RosterEntry => ({
  tier: "large",
  roles: [],
  limits: { rpm: null, rpd: null, tpm: null },
  trainsOnPrompts: false,
  strictSchema: null,
  knowledgeCutoff: null,
  checkedOn: "2026-11-17",
  status: "verified",
  sourceUrl: "https://example.invalid/limits",
  note: "test row",
  ...over,
});

const BIG = entry({ provider: "groq", modelId: "big-120b", tier: "large" });
const MID = entry({ provider: "groq", modelId: "mid-27b", tier: "medium" });
const SMALL = entry({ provider: "groq", modelId: "small-20b", tier: "small" });
const ROSTER_FIX = [BIG, MID, SMALL];
const KEYS = { GROQ_API_KEY: "test-key-not-real" };

const pass = (...models: string[]): RoleVerdict => ({
  verdict: "PASS",
  date: "2026-11-20",
  run: "r1",
  report: "r1.md",
  models,
});

type Over = Partial<FactoryCtx>;
const ctxOf = (over: Over = {}): FactoryCtx => ({
  params: defaultAgentParams(),
  kbVersion: "kb1",
  store: new MemoryStore(),
  liveRoles: ["R6"],
  index: { R6: pass("big-120b") },
  roster: ROSTER_FIX,
  env: KEYS,
  fetchImpl: vi.fn() as unknown as typeof fetch,
  ...over,
});

const reasonOf = (role: Role, over: Over = {}) => {
  const c = routerFor(role, ctxOf(over));
  return { ...c.route, mode: c.router.mode };
};

describe("truth table", () => {
  it("everything holds: live, one model, mode live", () => {
    const r = reasonOf("R6");
    expect(r).toMatchObject({ live: true, reason: null, mode: "live" });
    expect(r.models.map((m) => m.modelId)).toEqual(["big-120b"]);
  });

  it.each<[string, Over, RouteReason]>([
    ["not listed", { liveRoles: [] }, "not_listed"],
    ["another role listed", { liveRoles: ["R1"] }, "not_listed"],
    ["configuration unreadable (null)", { liveRoles: null }, "config_unreadable"],
    ["configuration absent", { liveRoles: undefined }, "config_unreadable"],
    ["no verdict", { index: {} }, "bakeoff_not_passed"],
    ["a FAIL verdict", { index: { R6: { ...pass(), verdict: "FAIL" } } }, "bakeoff_not_passed"],
    ["a PASS with no model", { index: { R6: pass() } }, "bakeoff_not_passed"],
    [
      "the passing model is not in the roster",
      { index: { R6: pass("ghost-1b") } },
      "model_not_routable",
    ],
    ["the model is retired", { roster: [{ ...BIG, status: "retired" }] }, "model_not_routable"],
    [
      "the model trains on prompts",
      { roster: [{ ...BIG, trainsOnPrompts: true }] },
      "model_not_routable",
    ],
    ["training unknown", { roster: [{ ...BIG, trainsOnPrompts: null }] }, "model_not_routable"],
    ["a tier the role may not use", { index: { R6: pass("small-20b") } }, "model_not_routable"],
    ["no tier recorded", { roster: [{ ...BIG, tier: null }] }, "model_not_routable"],
    [
      "no adapter for the provider",
      { roster: [{ ...BIG, provider: "github-models" }] },
      "model_not_routable",
    ],
    [
      "a paid openrouter model",
      {
        roster: [entry({ provider: "openrouter", modelId: "big-120b" })],
        env: { OPENROUTER_API_KEY: "x" },
      },
      "model_not_routable",
    ],
    ["no key", { env: {} }, "no_key"],
    ["a blank key", { env: { GROQ_API_KEY: "  " } }, "no_key"],
  ])("%s: rules-only with the reason", (_name, over, reason) => {
    const r = reasonOf("R6", over);
    expect(r).toMatchObject({ live: false, reason, mode: "rules-only", models: [] });
  });

  it("a free openrouter model is routable with its key", () => {
    const free = entry({ provider: "openrouter", modelId: "big-120b:free" });
    const r = reasonOf("R6", {
      roster: [free],
      index: { R6: pass("big-120b:free") },
      env: { OPENROUTER_API_KEY: "x" },
    });
    expect(r.live).toBe(true);
  });

  it("each condition alone is necessary: removing any one of the six from the live case turns it off", () => {
    const live = (o: Over) => reasonOf("R6", o).live;
    expect(live({})).toBe(true);
    expect([
      live({ liveRoles: [] }),
      live({ index: {} }),
      live({ roster: [{ ...BIG, status: "retired" }] }),
      live({ roster: [{ ...BIG, trainsOnPrompts: true }] }),
      live({ env: {} }),
      live({ liveRoles: null }),
    ]).toEqual([false, false, false, false, false, false]);
  });
});

describe("the words roles (D-1402)", () => {
  const wordsIdx = { words: pass("mid-27b") };
  it("R3 and R5 are gated by `words` alone: listing R3 or R5 changes nothing", () => {
    for (const role of ["R3", "R5"] as const) {
      expect(reasonOf(role, { liveRoles: [role], index: wordsIdx })).toMatchObject({
        live: false,
        reason: "not_listed",
        listedAlone: true,
      });
    }
  });

  it("`words` listed with a words PASS makes both live; their tiers are small and medium", () => {
    for (const role of ["R3", "R5"] as const) {
      const r = reasonOf(role, { liveRoles: ["words"], index: wordsIdx });
      expect(r).toMatchObject({ live: true, gate: "words" });
      expect(r.models.map((m) => m.modelId)).toEqual(["mid-27b"]);
    }
    // a large model passed the words test but R3 and R5 may not use that tier
    expect(
      reasonOf("R3", { liveRoles: ["words"], index: { words: pass("big-120b") } }).reason,
    ).toBe("model_not_routable");
  });

  it("R7 and R1 have their own verdicts; R6's PASS does not open R7", () => {
    expect(
      reasonOf("R7", { liveRoles: ["R7", "R6"], index: { R6: pass("big-120b") } }).reason,
    ).toBe("bakeoff_not_passed");
    expect(reasonOf("R7", { liveRoles: ["R7"], index: { R7: pass("big-120b") } }).live).toBe(true);
    expect(reasonOf("R1", { liveRoles: ["R1"], index: { R1: pass("mid-27b") } }).live).toBe(true);
  });
});

describe("tiers (LLM-080, D-1408)", () => {
  it("the chain is cheapest tier first, then roster order", () => {
    const r = routerFor(
      "R2",
      ctxOf({
        liveRoles: ["R2"],
        index: { R2: pass("big-120b", "mid-27b", "small-20b") },
        roster: [BIG, SMALL, MID],
      }),
    );
    // R2 allows small, medium, large; small is cheapest
    expect(r.route.models.map((m) => m.tier)).toEqual(["small", "medium", "large"]);
  });

  it("R6 allows large and medium only, large listed first in ROLE_TIERS but ordered cheapest first", () => {
    expect(ROLE_TIERS.R6).toEqual(["large", "medium"]);
    const r = routerFor("R6", ctxOf({ index: { R6: pass("big-120b", "mid-27b", "small-20b") } }));
    expect(r.route.models.map((m) => m.modelId)).toEqual(["mid-27b", "big-120b"]);
  });

  it("two models of one provider get distinct ids and both reach the router chain", () => {
    const night = liveRoutes(
      ctxOf({ liveRoles: ["R6"], index: { R6: pass("big-120b", "mid-27b") } }),
    );
    expect(night.providers.map((p) => p.id).sort()).toEqual(["groq:big-120b", "groq:mid-27b"]);
    expect(night.providers.every((p) => p.kind === "live" && !p.paid)).toBe(true);
  });

  it("a night with one model per provider uses the provider name as the id", () => {
    const night = liveRoutes(ctxOf());
    expect(night.providers.map((p) => p.id)).toEqual(["groq"]);
  });

  it("the roster gives every active row a tier and the ranks run small to large", () => {
    for (const e of ROSTER) {
      if (e.status !== "retired" && e.modelId !== "*")
        expect(e.tier, `${e.provider}/${e.modelId}`).not.toBeNull();
    }
    expect(TIER_RANK.small).toBeLessThan(TIER_RANK.medium);
    expect(TIER_RANK.medium).toBeLessThan(TIER_RANK.large);
  });

  it("the real roster gives no live route today (no verdict recorded)", () => {
    const s = routesStatus({ liveRoles: ["R1", "R2", "R6", "R7", "words"] }, { checkKeys: false });
    expect(s.roles.every((r) => !r.live && r.reason !== null)).toBe(true);
  });
});

describe("a newer FAIL supersedes an older PASS through the whole path", () => {
  const rep = (run: string, date: string, steel: "ok" | "FAIL") =>
    [
      "# LLM bake-off report",
      `- Run: ${run}`,
      `- Date: ${date}`,
      "## Summary",
      "## big-120b",
      "- trains_on_prompts: no; checked 2026-11-01",
      `| steelman | 10 | claim_validity | 100 | >= 98 | ${steel} |`,
      "| injection | 10 | resistance | 100 | >= 100 | ok |",
    ].join("\n");
  it("the older PASS opens the route, adding the newer FAIL closes it", () => {
    const old = { file: "a.md", text: rep("r1", "2026-11-01", "ok") };
    const idx1 = buildIndex([old]) as Record<GateRole, RoleVerdict>;
    expect(reasonOf("R6", { index: idx1 }).live).toBe(true);
    const idx2 = buildIndex([
      old,
      { file: "b.md", text: rep("r2", "2026-11-09", "FAIL") },
    ]) as Record<GateRole, RoleVerdict>;
    expect(reasonOf("R6", { index: idx2 })).toMatchObject({
      live: false,
      reason: "bakeoff_not_passed",
    });
  });
});

describe("routerFor makes the call only through the chosen provider", () => {
  const answer = JSON.stringify({ note: "live answer" });
  const groqOk = () =>
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: answer } }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
          {
            status: 200,
          },
        ),
    );

  it("rules-only never calls fetch, even with a key", async () => {
    const fetchImpl = groqOk();
    const c = routerFor(
      "R6",
      ctxOf({ liveRoles: [], fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    const res = await c.router.route(request({ role: "R6" }));
    expect(res.source).toBe("rules-only");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("live calls the provider once and the answer is the model's", async () => {
    const fetchImpl = groqOk();
    const c = routerFor("R6", ctxOf({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const res = await c.router.route(request({ role: "R6" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.value).toEqual({ note: "live answer" });
    expect(res.source).toBe("groq");
  });

  it("a provider failure falls back to the rules text", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const c = routerFor("R6", ctxOf({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const res = await c.router.route(request({ role: "R6" }));
    expect(res.value).toEqual(fixture.rulesNote);
    expect(res.llmUsed).toBe(false);
  });
});

describe("routesStatus and readLiveRoles", () => {
  it("lists the six roles in order with their gates, without building a provider", () => {
    const s = routesStatus(ctxOf({ liveRoles: ["words", "R6"] }), { checkKeys: false });
    expect(s.roles.map((r) => r.role)).toEqual(["R1", "R2", "R3", "R5", "R6", "R7"]);
    expect(s.roles.map((r) => r.gate)).toEqual(["R1", "R2", "words", "words", "R6", "R7"]);
    expect(gateOf("R4")).toBeNull();
    expect(gateOf("words")).toBe("words");
  });

  it("checkKeys false does not report a missing key", () => {
    const withKeys = routesStatus(ctxOf({ env: {} }), { checkKeys: false });
    expect(withKeys.roles.find((r) => r.role === "R6")!.live).toBe(true);
    expect(routesStatus(ctxOf({ env: {} })).roles.find((r) => r.role === "R6")!.reason).toBe(
      "no_key",
    );
  });

  it("every role has a plain word and no word is a job code", () => {
    for (const role of ["R1", "R2", "R3", "R5", "R6", "R7", "words"]) {
      expect(ROLE_WORDS[role], role).toBeTruthy();
      expect(ROLE_WORDS[role], role).not.toMatch(/\bR\d\b/);
    }
  });

  it("readLiveRoles reads the stored list, the default is empty, and a failing read is null", async () => {
    const db = await freshDb("main");
    try {
      expect(await readLiveRoles(db)).toEqual([]);
      await db.execute({
        sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
              VALUES ('llm_live_roles', 'global', '["R6"]', NULL, NULL, '2026-11-17T00:00:00.000Z', 'test')`,
        args: [],
      });
      expect(await readLiveRoles(db)).toEqual(["R6"]);
      expect(await readLiveRoles({ execute: () => Promise.reject(new Error("down")) })).toBeNull();
      await db.execute({
        sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason) VALUES ('llm_live_roles', 'global', '"R6"', NULL, NULL, '2026-11-17T00:00:01.000Z', 'test')`,
        args: [],
      });
      expect(await readLiveRoles(db)).toBeNull();
    } finally {
      cleanupTempDbs();
    }
  });
});
