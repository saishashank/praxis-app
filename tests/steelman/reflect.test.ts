// @vitest-environment node
// Pick reflections (M22 C3; AGT-146, AGT-134; D-1424, D-1411): one note per pick settled in the session, at most 80 words,
// every claim cites a fact or point id and is grounded, a rules-only night or a refused answer is a `not_written` row
// ("not available tonight"), the switch off writes nothing, the only table written is `pick_reflection`, the budget
// reservation is respected, and nothing throws. Synthetic ZZ data only (SEC-110).
import { afterEach, describe, expect, it } from "vitest";
import { allowance, scaledCap } from "@/lib/llm/budget";
import { reserveAfterLeft } from "@/lib/llm/dropOrder";
import { MemoryStore } from "@/lib/llm/store";
import {
  loadReflectionFacts,
  MAX_REFLECTION_WORDS,
  NOT_WRITTEN_REASON,
  reflectionCallReservation,
  reflectionReserve,
  reflectNight,
  settledPicks,
  validateClaims,
  type FactItem,
} from "@/lib/steelman/reflect";
import { wordCount } from "@/lib/steelman/claims";
import { cleanupTempDbs } from "../db/helpers";
import {
  D,
  goodAnswer,
  idsOf,
  MARKET,
  params,
  PICK,
  reflectLlm,
  reflectOptions,
  reflections,
  scripted,
  seedNight,
  seedPoints,
  settlePick,
  SETTLED_D,
  spy,
} from "./reflectHarness";

afterEach(cleanupTempDbs);

const answering = (text: string, citations?: (ids: string[]) => string[]) =>
  scripted("alpha", (req) => {
    const ids = idsOf(req.prompt);
    return JSON.stringify({
      claims: [{ text, citations: citations ? citations(ids) : [ids[0]!] }],
    });
  });

async function world(opts: { points?: boolean; missed?: boolean } = {}) {
  const db = await seedNight();
  await settlePick(db, { missed: opts.missed });
  const ids = opts.points === false ? [] : await seedPoints(db);
  return { db, ids };
}

describe("reflectNight: a written note", () => {
  it("writes one grounded note for the pick settled in the session, from the router answer", async () => {
    const { db, ids } = await world();
    const w = scripted("alpha", goodAnswer);
    const res = await reflectNight(db, reflectOptions(reflectLlm([w])));
    expect(res).toMatchObject({ status: "done", settled: 1, written: 1, notWritten: 0 });
    const [row] = await reflections(db);
    expect(row).toMatchObject({
      d: D,
      profile: PICK.profile,
      rank: 1,
      state: "written",
      provider: "alpha",
      reason: null,
    });
    expect(row!.model).toBe("alpha-model");
    expect(wordCount(String(row!.text))).toBeLessThanOrEqual(MAX_REFLECTION_WORDS);
    // the second claim cites the first point, so its id is on the row
    expect(JSON.parse(String(row!.agreed_point_ids_json))).toEqual([ids[0]]);
    // exactly one model call, given the facts of the pick
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.prompt).toContain("Outcome: bought on");
    expect(w.calls[0]!.prompt).toContain("Earlier case for");
  });

  it("a second run writes nothing new (one row per pick, append-only)", async () => {
    const { db } = await world();
    const w = scripted("alpha", goodAnswer);
    await reflectNight(db, reflectOptions(reflectLlm([w])));
    const again = await reflectNight(db, reflectOptions(reflectLlm([w])));
    expect(again).toMatchObject({ settled: 0, written: 0 });
    expect(await reflections(db)).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
  });

  it("only a pick that settled in this session is reflected on", async () => {
    const db = await seedNight();
    await settlePick(db, { settledD: "2026-03-11" });
    expect(await settledPicks(db, MARKET, SETTLED_D)).toEqual([]);
    expect(await settledPicks(db, MARKET, "2026-03-11")).toHaveLength(1);
    const res = await reflectNight(db, reflectOptions(reflectLlm([scripted("alpha", goodAnswer)])));
    expect(res.settled).toBe(0);
  });

  it("a missed pick is told as never bought, neither a win nor a loss", async () => {
    const { db } = await world({ missed: true, points: false });
    const facts = await loadReflectionFacts(db, MARKET, { ...PICK });
    expect(facts.map((f) => f.text).join("|")).toContain("never bought");
    expect(facts.every((f) => f.kind === "fact")).toBe(true);
  });
});

describe("reflectNight: rows that say nothing", () => {
  it("a rules-only night writes a not_written row 'not available tonight' (the router answers rules-only)", async () => {
    const { db } = await world();
    const w = scripted("alpha", goodAnswer);
    const res = await reflectNight(db, reflectOptions(reflectLlm([w], undefined, "rules-only")));
    expect(res).toMatchObject({ written: 0, notWritten: 1 });
    const [row] = await reflections(db);
    expect(row).toMatchObject({
      state: "not_written",
      reason: NOT_WRITTEN_REASON,
      text: "",
      provider: null,
    });
    expect(w.calls).toHaveLength(0);
  });

  it("a role that is not live is a not_written row and no model is called", async () => {
    const { db } = await world();
    const w = scripted("alpha", goodAnswer);
    const res = await reflectNight(db, reflectOptions(reflectLlm([w]), { live: { R6: false } }));
    expect(res).toMatchObject({ written: 0, notWritten: 1 });
    expect((await reflections(db))[0]).toMatchObject({
      state: "not_written",
      reason: NOT_WRITTEN_REASON,
    });
    expect(w.calls).toHaveLength(0);
  });

  it("pick_reflection_enabled off writes nothing at all and calls no model", async () => {
    const { db } = await world();
    const w = scripted("alpha", goodAnswer);
    const s = spy(db);
    const res = await reflectNight(s.exec, reflectOptions(reflectLlm([w]), { enabled: false }));
    expect(res).toMatchObject({ status: "off", written: 0, notWritten: 0 });
    expect(s.writes).toEqual([]);
    expect(await reflections(db)).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });
});

describe("reflectNight: the write allowlist", () => {
  it("every statement that changes data targets pick_reflection and nothing else", async () => {
    const { db } = await world();
    const s = spy(db);
    await reflectNight(s.exec, reflectOptions(reflectLlm([scripted("alpha", goodAnswer)])));
    expect(s.writes.length).toBeGreaterThan(0);
    for (const sql of s.writes)
      expect(sql, sql).toMatch(/^\s*INSERT OR IGNORE INTO pick_reflection\b/);
  });

  it("no other table changes: the pick, outcome, market, steelman and card rows are untouched", async () => {
    const { db } = await world();
    const dump = async () =>
      JSON.stringify(
        await Promise.all(
          [
            "pick",
            "pick_outcome",
            "pick_market",
            "steelman_pack",
            "steelman_point",
            "decision_card",
            "signal",
          ].map(async (t) =>
            (await db.execute(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows.map((r) => ({ ...r })),
          ),
        ),
      );
    const before = await dump();
    await reflectNight(db, reflectOptions(reflectLlm([scripted("alpha", goodAnswer)])));
    expect(await dump()).toBe(before);
  });
});

describe("reflectNight: what the checks refuse", () => {
  const refused = async (provider: ReturnType<typeof scripted>) => {
    const { db } = await world();
    const res = await reflectNight(db, reflectOptions(reflectLlm([provider])));
    expect(res).toMatchObject({ written: 0, notWritten: 1 });
    expect((await reflections(db))[0]).toMatchObject({
      state: "not_written",
      reason: NOT_WRITTEN_REASON,
      text: "",
    });
  };

  it("more than 80 words", async () => {
    const thirty = Array.from({ length: 30 }, () => "word").join(" ");
    await refused(
      scripted("alpha", (req) => {
        const ids = idsOf(req.prompt);
        return JSON.stringify({
          claims: [1, 2, 3].map(() => ({ text: thirty, citations: [ids[0]!] })),
        });
      }),
    );
  });

  it("a claim that cites an id that is not in the facts", async () => {
    await refused(answering("The pick was published with a stop.", () => ["F99"]));
  });

  it("a claim with no citation", async () => {
    await refused(answering("The pick was published with a stop.", () => []));
  });

  it("a number that is not in the cited item", async () => {
    await refused(answering("The pick lost 42.5% in a day.", (ids) => [ids[0]!]));
  });

  it("certainty wording, an instruction, a link", async () => {
    for (const t of [
      "It will recover soon.",
      "Buy more of it now.",
      "See www.example.org for more.",
    ])
      await refused(answering(t));
  });

  it("an answer that is not JSON of the shape", async () => {
    await refused(scripted("alpha", () => "not json"));
  });

  it("a provider that fails", async () => {
    const { db } = await world();
    const bad = scripted("alpha", () => "x", { call: () => Promise.reject(new Error("boom")) });
    const res = await reflectNight(db, reflectOptions(reflectLlm([bad])));
    expect(res).toMatchObject({ status: "done", written: 0, notWritten: 1 });
  });
});

describe("validateClaims", () => {
  const items: FactItem[] = [
    { id: "F01", kind: "fact", text: "The market moved 1.2% over the window" },
    { id: "P01", kind: "point", text: "Earlier case for: the rule passed", pointId: "x" },
  ];
  it("keeps claims whose numbers are verbatim in a cited item", () => {
    const ok = validateClaims(
      { claims: [{ text: "The market moved 1.2% in the window.", citations: ["F01"] }] },
      items,
    );
    expect(ok).toEqual([{ text: "The market moved 1.2% in the window.", citations: ["F01"] }]);
  });
  it("refuses an empty list, more than four claims, and a number cited elsewhere", () => {
    expect(validateClaims({ claims: [] }, items)).toBeNull();
    const c = { text: "The rule passed.", citations: ["P01"] };
    expect(validateClaims({ claims: [c, c, c, c, c] }, items)).toBeNull();
    expect(
      validateClaims(
        { claims: [{ text: "It moved 1.2% as the rule passed.", citations: ["P01"] }] },
        items,
      ),
    ).toBeNull();
  });
  it("deduplicates repeated citations", () => {
    const out = validateClaims(
      { claims: [{ text: "The rule passed.", citations: ["P01", "P01"] }] },
      items,
    );
    expect(out![0]!.citations).toEqual(["P01"]);
  });
});

describe("the budget reservation (D-1411)", () => {
  const spend = async (store: MemoryStore, role: "R6" | "R5", tokens: number) =>
    store.recordCall({
      id: `u-${role}-${tokens}`,
      role,
      provider: "alpha",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: tokens,
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: SETTLED_D,
    });

  it("a spent writer bucket skips the call: a not_written row, the writer never called", async () => {
    const { db } = await world();
    const store = new MemoryStore();
    await spend(store, "R6", params.llm.roleDailyTokens.R6);
    const w = scripted("alpha", goodAnswer);
    const res = await reflectNight(db, reflectOptions(reflectLlm([w], store)));
    expect(res).toMatchObject({ written: 0, notWritten: 1 });
    expect(w.calls).toHaveLength(0);
  });

  it("the Evening Review share is kept: with only that left the call is skipped", async () => {
    const { db } = await world();
    const store = new MemoryStore();
    const total = scaledCap(params.llm.dailyTotal, params.llm.marketShare[MARKET]);
    const r5 = scaledCap(params.llm.roleDailyTokens.R5, params.llm.marketShare[MARKET]);
    await spend(store, "R6", total - r5 - 10);
    const w = scripted("alpha", goodAnswer);
    const res = await reflectNight(db, reflectOptions(reflectLlm([w], store)));
    expect(res.written).toBe(0);
    expect(w.calls).toHaveLength(0);
  });

  it("reflectionReserve is the settled picks times the worst case of one call, and the steelman counts it", async () => {
    const { db } = await world();
    const one = reflectionCallReservation(MARKET, SETTLED_D);
    expect(one).toBeGreaterThan(0);
    expect(await reflectionReserve(db, MARKET, SETTLED_D)).toBe(one);
    expect(await reflectionReserve(db, MARKET, "2026-03-20")).toBe(0);
    const store = new MemoryStore();
    const usage = (k: Parameters<MemoryStore["usage"]>[0]) => store.usage(k, MARKET, SETTLED_D);
    const without = await reserveAfterLeft("steelman", params.llm, MARKET, usage);
    const withIt = await reserveAfterLeft("steelman", params.llm, MARKET, usage, one);
    expect(withIt - without).toBe(one);
    // the room the writer bucket has is larger than one call, so the reserve is real room, not a cap on everything
    expect(allowance(params.llm, "R6", MARKET, true, await usage("R6")).allowed).toBeGreaterThan(
      one,
    );
  });
});

describe("never throws", () => {
  it("a database that fails is a failed night, not an exception", async () => {
    const down = { execute: () => Promise.reject(new Error("down")) } as never;
    const res = await reflectNight(
      down,
      reflectOptions(reflectLlm([scripted("alpha", goodAnswer)])),
    );
    expect(res.status).toBe("failed");
  });

  it("a failing insert is counted and the night still finishes", async () => {
    const { db } = await world();
    const exec = {
      execute: ((q: string | { sql: string }) => {
        const sql = typeof q === "string" ? q : q.sql;
        return /INSERT OR IGNORE INTO pick_reflection/.test(sql)
          ? Promise.reject(new Error("full"))
          : db.execute(q as never);
      }) as typeof db.execute,
    };
    const res = await reflectNight(
      exec,
      reflectOptions(reflectLlm([scripted("alpha", goodAnswer)])),
    );
    expect(res).toMatchObject({ status: "done", settled: 1, written: 0, notWritten: 1 });
  });
});
