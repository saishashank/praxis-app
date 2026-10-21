// @vitest-environment node
// M7 T18 knowledge loaders (KB-070, UX-070/071a, UXN-200/201/208): content, rules-only masking for
// Editors and Viewers without a grant (no code, name, exact date, actor id or free text), the Owner and a
// granted viewer seeing stored values, and annotation visibility (UX-071a s13).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { CODES, envOf, NAMES, type Who } from "../loaders/world";
import { findLeaks } from "@/lib/view/mask";
import { loadKnowledge } from "@/lib/ui/loaders/knowledge";
import {
  dayText,
  documentHref,
  loadChallengerView,
  loadCompare,
  loadFamily,
  loadFamilySummaries,
  loadHypotheses,
  loadLedger,
  loadLesson,
  loadLessonCards,
  loadNotes,
  parseCompareIds,
  STAGES,
} from "@/lib/ui/loaders/knowledgeViews";
import { knowledgeWorld, type KnowledgeWorld } from "./seed";

afterAll(cleanupTempDbs);

let w: KnowledgeWorld;
beforeAll(async () => {
  w = await knowledgeWorld();
});

const MASKED: Who[] = ["editor", "viewer"];
const UNMASKED: Who[] = ["owner", "granted"];
const ISO_DAY = /\d{4}-\d{2}-\d{2}/;

async function everything(who: Who) {
  const env = envOf(w, who);
  return {
    knowledge: await loadKnowledge(env, {}),
    families: await loadFamilySummaries(env),
    family: await loadFamily(env, "F1"),
    cards: await loadLessonCards(env, {}),
    lesson: await loadLesson(env, "L-1"),
    challenger: await loadChallengerView(env, w.challengerId),
    compare: await loadCompare(env, [w.challengerId, "F1.v1"]),
    ledger: await loadLedger(env),
    hypotheses: await loadHypotheses(env),
  };
}

describe("content for the Owner", () => {
  it("lists families with their live version and counts", async () => {
    const f = await loadFamilySummaries(envOf(w, "owner"));
    expect(f.map((x) => x.family)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
    expect(f[0]).toMatchObject({ liveId: w.challengerVersion, versions: 2, challengers: 1 });
    expect(f[1]).toMatchObject({ liveId: "F2.v1", lessons: 1 });
  });

  it("builds lesson cards with headline, grade, metric and n (UXN-200)", async () => {
    const cards = await loadLessonCards(envOf(w, "owner"), {});
    const l1 = cards.find((c) => c.id === "L-1")!;
    expect(l1).toMatchObject({ grade: "L2", n: 120, metric: "net ppm", family: "F1" });
    expect(l1.gradeText).toBe("Held up in the last third that was kept aside");
    const l2 = cards.find((c) => c.id === "L-2")!;
    expect(l2).toMatchObject({ grade: "L0", n: 15, headline: "Mean reversion" });
  });

  it("filters lessons by grade, family and search text", async () => {
    const env = envOf(w, "owner");
    expect((await loadLessonCards(env, { grade: "L0" })).map((c) => c.id)).toEqual(["L-2"]);
    expect((await loadLessonCards(env, { family: "F1" })).map((c) => c.id)).toEqual(["L-1"]);
    expect((await loadLessonCards(env, { q: "reversion" })).map((c) => c.id)).toEqual(["L-2"]);
    expect(await loadLessonCards(env, { q: "100%_" })).toEqual([]);
  });

  it("shows version history with parameters, bounds and changes from the parent", async () => {
    const fam = await loadFamily(envOf(w, "owner"), "F1");
    expect(fam.liveId).toBe(w.challengerVersion);
    const v2 = fam.versions.find((v) => v.id === w.challengerVersion)!;
    expect(v2.wasLive).toBe(true);
    expect(v2.changes.length).toBeGreaterThan(0);
    expect(v2.params.some((p) => p.min !== null && p.max !== null)).toBe(true);
    const v1 = fam.versions.find((v) => v.id === "F1.v1")!;
    expect(v1).toMatchObject({ wasLive: true, status: "shadow", parent: null, changes: [] });
  });

  it("reads one lesson with its Critic checks and one challenger with its history", async () => {
    const env = envOf(w, "owner");
    const l = await loadLesson(env, "L-1");
    expect(l?.critique?.checks.map((c) => c.state)).toEqual(["pass", "pending"]);
    expect(l?.history[0]).toMatchObject({ grade: "L2", n: 120 });
    const c = await loadChallengerView(env, w.challengerId);
    expect(c?.events.length).toBeGreaterThan(0);
    expect(c?.critique?.notes[0]?.text).toContain("ZZUP");
    expect(c?.changes.length).toBeGreaterThan(0);
    expect(await loadLesson(env, "nope")).toBeNull();
    expect(await loadChallengerView(env, "C-nope")).toBeNull();
    expect(await loadLesson(env, "x".repeat(201))).toBeNull();
  });

  it("compares the champion and a challenger and never claims significance (UXN-201, UXN-208)", async () => {
    const m = await loadCompare(envOf(w, "owner"), [w.challengerId, "F1.v1", "C-missing"]);
    expect(m.missing).toBe(1);
    const ch = m.items.find((i) => i.kind === "challenger")!;
    expect(ch.holdout).toBe("not yet significant");
    expect(ch.tests[0]).toMatchObject({ test: "holdout", outcome: "not confirmed", n: 40 });
    expect(ch.tests[0]!.estimate).toBe("0.01235");
    expect(ch.criticPassed).toBe(1);
    expect(ch.criticTotal).toBe(2);
    // Every stage label is a real KB-040 name; the champion has no stage.
    expect(STAGES as readonly string[]).toContain(ch.stage);
    expect(m.items.find((i) => i.kind === "champion")?.stage).toBeNull();
  });

  it("parses the compare list: 2 to 5 distinct ids, comma or repeated", () => {
    expect(parseCompareIds(["a,b"])).toEqual(["a", "b"]);
    expect(parseCompareIds(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(parseCompareIds(["a"])).toBeNull();
    expect(parseCompareIds(["a,b,c,d,e,f"])).toBeNull();
    expect(parseCompareIds(["a,b c"])).toBeNull();
    expect(parseCompareIds([`a,${"x".repeat(201)}`])).toBeNull();
    expect(parseCompareIds(["a,b,c,d,e"])).toHaveLength(5);
  });

  it("links documents to their pages", () => {
    expect(documentHref("knowledge/au/lessons/L-9.md")).toBe("/reviews/learned/lessons/L-9");
    expect(documentHref("knowledge/au/challengers/C-9.md")).toBe(
      "/reviews/learned/challengers/C-9",
    );
    expect(documentHref("knowledge/au/families/F2.md")).toBe("/reviews/learned/families/F2");
    expect(documentHref("knowledge/au/families/F9.md")).toBeNull();
    expect(documentHref("knowledge/au/reviews/2026-10-19.md")).toBeNull();
  });

  it("shows the ledger and hypotheses as stored", async () => {
    const env = envOf(w, "owner");
    const l = await loadLedger(env);
    expect(l[0]).toMatchObject({ kind: "promotion", target: "F1", actor: "u1" });
    expect(l[0]!.summary).toContain("ZZUP");
    expect((await loadLedger(env, "F2")).length).toBe(0);
    const h = await loadHypotheses(env);
    expect(h[0]).toMatchObject({ id: "H-1", title: "Is ZZUP a leader?" });
  });

  it("the empty world has nothing and does not throw", async () => {
    const { emptyWorld } = await import("../loaders/world");
    const e = await emptyWorld();
    const env = envOf(e, "owner");
    expect(await loadLessonCards(env, {})).toEqual([]);
    expect(await loadLedger(env)).toEqual([]);
    expect(await loadHypotheses(env)).toEqual([]);
    expect((await loadFamily(env, "F1")).state).toBe("empty");
    expect((await loadFamilySummaries(env))[0]).toMatchObject({ liveId: null, versions: 0 });
  });
});

describe("rules-only content for masked users (DAT-124, UX-009)", () => {
  it.each(MASKED)(
    "%s: no stock code, name, exact date, actor id or free text in any model",
    async (who) => {
      const all = await everything(who);
      expect(findLeaks(all, CODES, NAMES)).toEqual([]);
      // The T8 `knowledge` model keeps raw dates; the page turns them into weeks with dayText.
      const { knowledge: raw, ...mine } = all;
      expect(raw.masked).toBe(true);
      expect(JSON.stringify(mine)).not.toMatch(ISO_DAY);
      const text = JSON.stringify(all);
      expect(text).not.toContain("Looks fitted");
      expect(text).not.toContain("trail 3 to 2.5");
      expect(text).not.toContain('"u1"');
    },
  );

  it.each(MASKED)("%s: the model still has the rules (grades, families, stages)", async (who) => {
    const all = await everything(who);
    expect(all.knowledge.masked).toBe(true);
    expect(all.cards.map((c) => c.grade).sort()).toEqual(["L0", "L2"]);
    expect(all.family.versions.length).toBe(2);
    expect(all.challenger?.state).toBeTruthy();
    expect(all.ledger[0]).toMatchObject({ kind: "promotion", actor: null, summary: null });
    expect(all.ledger[0]!.day).toMatch(/^\d{4}-W\d{2}$/);
    expect(all.lesson?.critique?.notes).toEqual([]);
  });

  it.each(UNMASKED)("%s sees the stored values", async (who) => {
    const all = await everything(who);
    expect(all.knowledge.masked).toBe(false);
    expect(JSON.stringify(all)).toContain("ZZUP");
    expect(all.ledger[0]!.day).toBe("Mon 19 Oct 2026");
  });

  it("shows a week, not a date, for a masked user", () => {
    expect(dayText("2026-10-19", true)).toBe("2026-W43");
    expect(dayText("2026-10-19", false)).toBe("Mon 19 Oct 2026");
    expect(dayText(null, true)).toBe("n/a");
    expect(dayText("junk", true)).toBe("n/a");
  });
});

describe("annotations (UX-071a)", () => {
  it("the Owner and an Editor read the text; the author or the Owner may change a note", async () => {
    const own = (await loadNotes(envOf(w, "owner"), "lesson", ["L-1"])).get("L-1")!;
    expect(own.map((n) => [n.role, n.text, n.canChange])).toEqual([
      ["owner", "Recheck ZZUP next week", true],
      ["editor", "Agree", true],
    ]);
    const ed = (await loadNotes(envOf(w, "editor"), "lesson", ["L-1"])).get("L-1")!;
    expect(ed.map((n) => n.canChange)).toEqual([false, true]);
    // A masked editor sees the text, but a stock code in it is masked.
    expect(ed[0]!.text).not.toContain("ZZUP");
  });

  it("a Viewer sees only that a note was added, never the text", async () => {
    const v = (await loadNotes(envOf(w, "viewer"), "lesson", ["L-1"])).get("L-1")!;
    expect(v.map((n) => n.text)).toEqual([null, null]);
    expect(v.every((n) => !n.canChange)).toBe(true);
    expect(v[0]!.day).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("an empty id list reads nothing", async () => {
    expect((await loadNotes(envOf(w, "owner"), "lesson", [])).size).toBe(0);
  });

  it("hypothesis notes ride along with the hypotheses", async () => {
    const h = (await loadHypotheses(envOf(w, "viewer")))[0]!;
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.text).toBeNull();
  });
});
