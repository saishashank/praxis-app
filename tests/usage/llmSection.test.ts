// @vitest-environment node
// LLM usage on the Usage page (LLM-051, UX-100; M7 T19b): the loader reads our own call log, is
// Owner-only, and the page shows it. Counts, tokens, cache hit rate, fallback rate and failures.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { loadLlmUsage, pct } from "@/lib/ui/loaders/usageLlm";

afterEach(cleanupTempDbs);

const NOW = new Date("2026-10-20T03:00:00Z");

type Call = {
  role: string;
  provider: string;
  depth: string;
  tin: number;
  tout: number;
  cached: number;
  outcome: string;
  d: string;
  market?: string;
  model?: string;
};
let n = 0;
async function insert(db: Awaited<ReturnType<typeof freshDb>>, c: Call) {
  n += 1;
  await db.execute({
    sql: `INSERT INTO llm_call (id, role, provider, model_id, fallback_depth, tokens_in, tokens_out, cached,
            outcome, injection_filtered, market, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    args: [
      `c${n}`,
      c.role,
      c.provider,
      c.model ?? null,
      c.depth,
      c.tin,
      c.tout,
      c.cached,
      c.outcome,
      c.market ?? "AU",
      c.d,
    ],
  });
}

describe("loadLlmUsage", () => {
  it("is Owner-only: every other role gets nothing and no query runs", async () => {
    const db = { execute: vi.fn() };
    for (const role of ["editor", "viewer", null, undefined])
      expect(await loadLlmUsage(db, role, NOW)).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("is empty before any call is logged (data-only mode)", async () => {
    const db = await freshDb("main");
    expect(await loadLlmUsage(db, "owner", NOW)).toEqual({
      sinceD: "2026-09-20",
      byRole: [],
      byDay: [],
      models: [],
    });
  });

  it("lists the models that answered, by role, with calls and last day (D-174)", async () => {
    const db = await freshDb("main");
    const base = { tin: 1, tout: 1, cached: 0, depth: "0", outcome: "ok" };
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "groq",
      model: "llama-3.3-70b",
      d: "2026-10-18",
    });
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "groq",
      model: "llama-3.3-70b",
      d: "2026-10-19",
    });
    await insert(db, {
      ...base,
      role: "critic",
      provider: "google",
      model: "gemini-2.5-flash",
      d: "2026-10-19",
    });
    await insert(db, { ...base, role: "critic", provider: "rules", d: "2026-10-19" }); // no model
    const out = await loadLlmUsage(db, "owner", NOW);
    expect(out?.models).toEqual([
      {
        role: "critic",
        provider: "google",
        model: "gemini-2.5-flash",
        calls: 1,
        lastD: "2026-10-19",
      },
      { role: "narrator", provider: "groq", model: "llama-3.3-70b", calls: 2, lastD: "2026-10-19" },
    ]);
  });

  it("counts calls, tokens, cache hits, fallbacks and failures per role/provider and per day", async () => {
    const db = await freshDb("main");
    const base = { tin: 10, tout: 20, cached: 0 };
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "gemini",
      depth: "0",
      outcome: "ok",
      d: "2026-10-19",
    });
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "gemini",
      depth: "0",
      outcome: "ok",
      d: "2026-10-19",
    });
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "gemini",
      depth: "0",
      cached: 1,
      outcome: "cache-hit",
      d: "2026-10-19",
    });
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "groq",
      depth: "1",
      outcome: "ok",
      d: "2026-10-19",
    });
    await insert(db, {
      role: "narrator",
      provider: "rules-only",
      depth: "rules-only",
      tin: 0,
      tout: 0,
      cached: 0,
      outcome: "LLM budget exhausted",
      d: "2026-10-18",
    });
    await insert(db, {
      role: "triage",
      provider: "rules-only",
      depth: "rules-only",
      tin: 0,
      tout: 0,
      cached: 0,
      outcome: "rules-only",
      d: "2026-10-18",
    });
    // outside the windows or another market: not counted
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "gemini",
      depth: "0",
      outcome: "ok",
      d: "2026-08-01",
    });
    await insert(db, {
      ...base,
      role: "narrator",
      provider: "gemini",
      depth: "0",
      outcome: "ok",
      d: "2026-10-19",
      market: "US",
    });

    const u = (await loadLlmUsage(db, "owner", NOW))!;
    expect(u.sinceD).toBe("2026-09-20");
    const gem = u.byRole.find((r) => r.role === "narrator" && r.provider === "gemini")!;
    expect(gem).toMatchObject({
      calls: 3,
      tokensIn: 30,
      tokensOut: 60,
      cached: 1,
      fallbacks: 0,
      failures: 0,
      cachePct: 33,
      fallbackPct: 0,
    });
    expect(u.byRole.find((r) => r.provider === "groq")).toMatchObject({
      calls: 1,
      fallbacks: 1,
      fallbackPct: 100,
      failures: 0,
    });
    // a budget refusal is a failure; the Owner's rules-only mode is not
    expect(
      u.byRole.find((r) => r.role === "narrator" && r.provider === "rules-only"),
    ).toMatchObject({
      failures: 1,
      fallbacks: 1,
    });
    expect(u.byRole.find((r) => r.role === "triage")).toMatchObject({ failures: 0, fallbacks: 1 });
    // ordered by calls, then role and provider
    expect(u.byRole.map((r) => `${r.role}/${r.provider}`)).toEqual([
      "narrator/gemini",
      "narrator/groq",
      "narrator/rules-only",
      "triage/rules-only",
    ]);
    // per day, newest first; the 2026-08-01 call is outside the 14-day window
    expect(u.byDay.map((r) => `${r.d} ${r.provider}`)).toEqual([
      "2026-10-19 gemini",
      "2026-10-19 groq",
      "2026-10-18 rules-only",
    ]);
    expect(u.byDay[2]).toMatchObject({ calls: 2, failures: 1 });
  });

  it("rates round half up in integers and are null over zero calls", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
    expect(pct(1, 8)).toBe(13); // 12.5 rounds up
    expect(pct(0, 5)).toBe(0);
    expect(pct(0, 0)).toBeNull();
  });
});
