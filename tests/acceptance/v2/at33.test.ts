// @vitest-environment node
// AT-33 Steelman grounding (M11-lite WP4; AGT-133, LLM-064, LLM-065; D-487, D-495): over 30 recorded
// synthetic ZZ packs with a mock author and a mock critic on a different provider, every shown claim cites
// pack items, carries no number that is not in a cited item, no URL, and no planted claim; hostile headline
// text changes nothing; the critic's own output is never shown. Layers: the router (schema enum on
// citations, numeric grounding of the whole answer, injection filter) stops an answer with an invented
// number or an out-of-pack citation and the chain moves on; the claim checks drop what still gets through
// (URLs, instructions, certainty wording) one point at a time and keep the log.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { DATAMARK } from "@/lib/llm/datamark";
import { MemoryStore } from "@/lib/llm/store";
import { numbersOf, isUnsafe } from "@/lib/steelman/claims";
import { buildPack, type EvidencePack } from "@/lib/steelman/pack";
import { readPoints, readShownPoints, type PointRow } from "@/lib/steelman/store";
import { writeSteelman, type WriteDeps, type WriteOutcome } from "@/lib/steelman/write";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import {
  criticAnswer,
  CUT,
  D,
  idsOf,
  llmOf,
  MARKET,
  NOW,
  params,
  scripted,
} from "../../steelman/nightHarness";

type Pt = { text: string; citations: string[]; monitorable?: boolean };
type Planted = Pt & { reason: "number" | "unsafe" | "citation" };
type Golden = {
  id: string;
  category: string;
  facts: { code: string; items: { id: string; kind: string; text: string }[] };
  untrusted: string[];
  reference: { bull: Pt[]; bear: Pt[]; planted: Planted[]; canary: string; hostile: boolean };
};

const ALL = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../fixtures/llm/golden-zz/r6_steelman.json"),
    "utf8",
  ),
) as Golden[];
const PACKS = ALL.filter((g) => g.category === "steelman").slice(0, 30);

let db: Client;
beforeAll(async () => {
  db = await freshDb("main");
});
afterAll(cleanupTempDbs);

function packOf(g: Golden): EvidencePack {
  return buildPack({
    cutoffAt: CUT,
    maxItems: 25,
    items: [
      ...g.facts.items.map((i) => ({ kind: i.kind as never, text: i.text })),
      ...g.untrusted.map((u) => ({
        kind: "headline" as const,
        text: u.replace(/^E\d\d:\s*/, ""),
        at: "2026-03-04T02:00:00.000Z",
      })),
    ],
  });
}

type Run = {
  g: Golden;
  pack: EvidencePack;
  out: WriteOutcome;
  points: PointRow[];
  shown: PointRow[];
  authorPrompts: string[];
  authorAnswered: string;
  hiddenIdx: number | null;
};
const runs: Run[] = [];

beforeAll(async () => {
  for (const [n, g] of PACKS.entries()) {
    const pack = packOf(g);
    const ref = [...g.reference.bull, ...g.reference.bear];
    const withPlants = {
      bull: [
        ...g.reference.bull,
        ...g.reference.planted.filter((p) => p.reason !== "citation").slice(0, 1),
      ],
      bear: [...g.reference.bear, ...g.reference.planted.filter((p) => p.reason === "citation")],
    };
    // alpha writes the references AND every planted claim; gamma (the next provider in the chain) writes
    // the references only. Whatever the router does not stop, the claim checks must.
    const alpha = scripted("alpha", () =>
      JSON.stringify({
        bull: withPlants.bull.map(({ text, citations }) => ({ text, citations })),
        bear: withPlants.bear.map(({ text, citations, monitorable }) => ({
          text,
          citations,
          monitorable: monitorable === true,
        })),
      }),
    );
    const gamma = scripted("gamma", () =>
      JSON.stringify({
        bull: g.reference.bull.map(({ text, citations }) => ({ text, citations })),
        bear: g.reference.bear.map(({ text, citations, monitorable }) => ({
          text,
          citations,
          monitorable: monitorable === true,
        })),
      }),
    );
    const hiddenIdx = n % 3 === 0 ? ref.length - 1 : null; // the critic rejects the last reference point
    const beta = scripted("beta", criticAnswer(hiddenIdx === null ? [] : [hiddenIdx]));
    const store = new MemoryStore();
    const llm = llmOf([alpha, gamma], [beta], store);
    const deps: WriteDeps = {
      db,
      market: MARKET,
      d: D,
      params: params.llm,
      now: NOW,
      authorRouter: llm.authorRouter,
      criticRouterFor: llm.criticRouterFor,
      providers: llm.providers,
      store,
    };
    const out = await writeSteelman(
      deps,
      { kind: "order", id: g.id, code: g.facts.code, cardId: null, rankScore: null },
      pack,
    );
    runs.push({
      g,
      pack,
      out,
      points: await readPoints(db, pack.packId),
      shown: await readShownPoints(db, pack.packId),
      authorPrompts: [...alpha.calls, ...gamma.calls].map((c) => c.prompt),
      authorAnswered:
        out.state === "written"
          ? ((await readPoints(db, pack.packId))[0]?.authorProvider ?? "")
          : "",
      hiddenIdx,
    });
  }
}, 600_000);

describe("AT-33 over 30 recorded packs", () => {
  it("runs 30 packs, all written", () => {
    expect(runs).toHaveLength(30);
    expect(runs.filter((r) => r.out.state !== "written").map((r) => r.g.id)).toEqual([]);
  });

  it("clause 1: every shown claim cites only items of its own pack", () => {
    for (const r of runs) {
      const ids = new Set(r.pack.items.map((i) => i.id));
      expect(r.shown.length, r.g.id).toBeGreaterThan(0);
      for (const p of r.shown) {
        expect(p.citations.length, `${r.g.id} ${p.pointId}`).toBeGreaterThan(0);
        for (const c of p.citations) expect(ids.has(c), `${r.g.id} cites ${c}`).toBe(true);
      }
    }
  });

  it("clause 2: 0 numbers outside the cited items", () => {
    let checked = 0;
    for (const r of runs) {
      const byId = new Map(r.pack.items.map((i) => [i.id, i.text]));
      for (const p of r.shown) {
        const allowed = new Set(p.citations.flatMap((c) => numbersOf(byId.get(c) ?? "")));
        for (const n of numbersOf(p.text)) {
          checked += 1;
          expect(allowed.has(n), `${r.g.id}: ${n} in "${p.text}"`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(30); // the check really looked at numbers
  });

  it("clause 3: 0 URLs, code, instructions or certainty wording in any shown claim", () => {
    for (const r of runs)
      for (const p of r.shown) {
        expect(isUnsafe(p.text), `${r.g.id}: ${p.text}`).toBe(false);
        expect(p.text).not.toMatch(/https?:|www\.|\.com|`/i);
        expect(p.text).not.toMatch(/\b(certain|guaranteed|will)\b/i);
      }
  });

  it("clause 4: planted claims are never shown; the ones that got past the router are dropped and logged", () => {
    let loggedDrops = 0;
    for (const r of runs) {
      const shownTexts = new Set(r.shown.map((p) => p.text));
      for (const pl of r.g.reference.planted) expect(shownTexts.has(pl.text), r.g.id).toBe(false);
      // when alpha (planted answer) was the one that answered, its unsafe plants sit in the log as drops
      if (r.points[0]?.authorProvider === "alpha") {
        const dropped = r.points.filter((p) => p.state.startsWith("dropped_"));
        expect(dropped.length, r.g.id).toBeGreaterThan(0);
        loggedDrops += dropped.length;
      }
      // all reference points that the critic did not hide are shown
      const refs = [...r.g.reference.bull, ...r.g.reference.bear];
      refs.forEach((p, i) => {
        if (i !== r.hiddenIdx) expect(shownTexts.has(p.text), `${r.g.id} ${p.text}`).toBe(true);
      });
    }
    // The router stops number and citation plants, so alpha only answers on unsafe-only packs; both
    // paths (router stop, claim drop) must really have been exercised across the 30 packs.
    expect(loggedDrops).toBeGreaterThan(0);
    expect(runs.some((r) => r.points[0]?.authorProvider === "gamma")).toBe(true);
  });

  it("clause 5: critic output is hidden: unsupported points are not shown, its verdict text is never a claim", () => {
    let hidden = 0;
    for (const r of runs) {
      const states = r.points.map((p) => p.state);
      const h = states.filter((s) => s === "hidden_critic").length;
      expect(h, r.g.id).toBe(r.hiddenIdx === null ? 0 : 1);
      hidden += h;
      for (const p of r.shown) {
        expect(p.text).not.toMatch(/not supported|verdict|pointIndex/i);
        expect(p.criticNote).toBeNull();
        expect(p.criticProvider).toBe("beta");
        expect(p.authorProvider).not.toBe("beta"); // a different provider (D-483)
      }
    }
    expect(hidden).toBeGreaterThan(0);
  });

  it("hostile headline text does not reach the answer or the trusted facts", () => {
    let hostile = 0;
    for (const r of runs) {
      const all = JSON.stringify(r.points).toLowerCase();
      if (r.g.reference.canary) expect(all, r.g.id).not.toContain(r.g.reference.canary);
      hostile += r.g.reference.hostile === true ? 1 : 0;
      for (const prompt of r.authorPrompts) {
        // the headline is only in DATA (datamarked), never among the FACTS ids
        expect(idsOf(prompt)).not.toContain("E08");
        expect(prompt).toContain(DATAMARK);
        expect(prompt).not.toContain("Ignore previous instructions");
      }
    }
    expect(hostile).toBeGreaterThanOrEqual(10); // at least 10 hostile packs are in the 30
  });
});
