// @vitest-environment node
// AT-80 (routes part, M22 L1; LLM-077, D-1401, D-1446): nothing goes live by itself.
//  - a fresh configuration: every night role answers from its template and no provider request is made (network spy);
//  - a role listed without a bake-off PASS stays rules-only and the health line says why in plain words;
//  - a PASS report plus the listing plus a key opens the route, and then the provider is called through the one router.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { loadLlmRoutesHealth } from "@/lib/health/llmRoutes";
import { loadNightLlm } from "@/lib/llm/nightlyLlm";
import { ROLE_WORDS, type RosterEntry } from "@/lib/llm/roster";
import type { GateRole } from "@/lib/llm/roster";
import type { RoleVerdict } from "@/lib/llm/bakeoffIndex.generated";
import { buildIndex } from "../../../scripts/llm/bakeoff-index.mjs";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { fixture, request } from "../../llm/helpers";

const net = vi.fn();
beforeEach(() => {
  net.mockReset();
  vi.stubGlobal("fetch", net);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanupTempDbs();
});

const setList = (db: Awaited<ReturnType<typeof freshDb>>, list: string[]) =>
  db.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
          VALUES ('llm_live_roles', 'global', ?, NULL, NULL, '2026-11-17T00:00:00.000Z', 'test')`,
    args: [JSON.stringify(list)],
  });

const ROLES = ["R1", "R2", "R3", "R5", "R6", "R7"] as const;

describe("AT-80 routes: a fresh configuration makes no provider request", () => {
  it("every role answers from its template, with the keys present and the list empty", async () => {
    const db = await freshDb("main");
    const night = await loadNightLlm({
      db,
      params: defaultAgentParams(),
      kbVersion: "kb1",
      env: { GROQ_API_KEY: "k", GOOGLE_AI_API_KEY: "k", OPENROUTER_API_KEY: "k" },
    });
    expect(night.providers).toEqual([]);
    for (const role of ROLES) {
      const res = await night
        .routerFor(role)
        .route(request({ role, market: "AU", d: "2026-03-05" }));
      expect(res.source, role).toBe("rules-only");
      expect(res.value).toEqual(fixture.rulesNote);
    }
    expect(net).not.toHaveBeenCalled();
    expect(night.status.roles.every((r) => !r.live && r.reason === "not_listed")).toBe(true);
    const health = await loadLlmRoutesHealth(db);
    expect(health.lines).toEqual(["AI jobs: all on written rules (none switched on)"]);
  });
});

describe("AT-80 routes: listed without a passing test run", () => {
  it("R6 listed, no PASS: rules-only, no request, and the health line says so in plain words", async () => {
    const db = await freshDb("main");
    await setList(db, ["R6"]);
    const night = await loadNightLlm({
      db,
      params: defaultAgentParams(),
      kbVersion: "kb1",
      env: { GROQ_API_KEY: "k" },
    });
    const res = await night.routerFor("R6").route(request({ role: "R6" }));
    expect(res.source).toBe("rules-only");
    expect(net).not.toHaveBeenCalled();
    const route = night.status.roles.find((r) => r.role === "R6")!;
    expect(route).toMatchObject({ live: false, reason: "bakeoff_not_passed" });
    const health = await loadLlmRoutesHealth(db);
    expect(health).toEqual({
      state: "attention",
      lines: ["Case writing: rules only, test run not passed yet"],
    });
    for (const line of health.lines) expect(line).not.toMatch(/\bR[1-7]\b/);
    expect(ROLE_WORDS.R6).toBe("case writing");
  });

  it("an unreadable setting keeps everything on rules and the health line says it could not be read", async () => {
    const db = await freshDb("main");
    const night = await loadNightLlm({
      db: { execute: () => Promise.reject(new Error("down")), close() {} } as never,
      params: defaultAgentParams(),
      kbVersion: "kb1",
      env: { GROQ_API_KEY: "k" },
    });
    expect(night.status.liveRoles).toBeNull();
    expect(night.status.roles.every((r) => r.reason === "config_unreadable")).toBe(true);
    const bad = await loadLlmRoutesHealth({ execute: () => Promise.reject(new Error("down")) });
    expect(bad.state).toBe("attention");
    expect(bad.lines[0]).toMatch(/could not be read/);
    void db;
  });
});

describe("AT-80 routes: a recorded PASS, the listing and a key open the route", () => {
  const MODEL = "test-large-120b";
  const roster: RosterEntry[] = [
    {
      provider: "groq",
      modelId: MODEL,
      tier: "large",
      roles: [],
      limits: { rpm: null, rpd: null, tpm: null },
      trainsOnPrompts: false,
      strictSchema: null,
      knowledgeCutoff: null,
      checkedOn: "2026-11-17",
      status: "verified",
      sourceUrl: "https://example.invalid/limits",
      note: "fixture row",
    },
  ];
  const report = [
    "# LLM bake-off report",
    "",
    "- Run: fixture-1",
    "- Date: 2026-11-20",
    "",
    "## Summary",
    "",
    `## ${MODEL}`,
    "",
    "- trains_on_prompts: no; checked 2026-11-01",
    "",
    "| steelman | 12 | claim_validity | 100 | >= 98 | ok |",
    "| injection | 12 | resistance | 100 | >= 100 | ok |",
  ].join("\n");
  const index = buildIndex([{ file: "fixture-1.md", text: report }]) as Record<
    GateRole,
    RoleVerdict
  >;

  it("the provider is called once, through the router, with the key in the header only", async () => {
    const db = await freshDb("main");
    await setList(db, ["R6"]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ note: "from the model" }) } }],
            usage: { prompt_tokens: 9, completion_tokens: 3 },
          }),
          { status: 200 },
        ),
    );
    const night = await loadNightLlm({
      db,
      params: defaultAgentParams(),
      kbVersion: "kb1",
      env: { GROQ_API_KEY: "fixture-key" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      index,
      roster,
    });
    expect(night.providers.map((p) => p.id)).toEqual(["groq"]);
    const res = await night
      .routerFor("R6")
      .route(request({ role: "R6", market: "AU", d: "2026-03-05" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.value).toEqual({ note: "from the model" });
    expect(net).not.toHaveBeenCalled(); // the global fetch is untouched; only the injected one was used
    const call = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(call[0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(call[1].body).not.toContain("fixture-key");
    // another role stays on rules: only R6 was listed
    const other = await night.routerFor("R1").route(request({ role: "R1" }));
    expect(other.source).toBe("rules-only");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const health = await loadLlmRoutesHealth(db, { index, roster });
    expect(health).toEqual({ state: "ok", lines: ["Case writing: live model, 1 model in order"] });
  });
});
