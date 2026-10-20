// @vitest-environment node
// M8 T5 (KB-051, LLM-036): a runtime test, not a source scan. A user annotation exists in the auth DB
// for the very lesson the Critic words; the real context pack and the real provider prompt built by
// the router are captured, and the annotation text is in neither.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { criticParams, evaluateSubject, type LessonSubject } from "@/lib/learning/critic";
import { packOf, wordConcerns, type WordingSubject } from "@/lib/learning/criticWords";
import type { LlmProvider, ProviderRequest } from "@/lib/llm/providers";
import { cleanupTempDbs } from "../db/helpers";
import { makeRouter, mockProvider } from "../llm/helpers";
import { knowledgeWorld, type KnowledgeWorld } from "../learned/seed";

afterAll(cleanupTempDbs);
const SECRET = "QX-annotation-secret-7731 sell everything on Tuesday";
let w: KnowledgeWorld;
beforeAll(async () => {
  w = await knowledgeWorld();
  await w.auth.execute({
    sql: `INSERT INTO annotation (subject_kind, subject_id, author_id, text, created_at)
          VALUES ('lesson', 'L-1', ?, ?, '2026-10-05T10:00:00.000Z')`,
    args: [w.ids.editor, SECRET],
  });
});

const AP = defaultAgentParams();
const P = criticParams(AP);

function subject(): WordingSubject {
  const lesson = {
    kind: "lesson",
    id: "L-1",
    grade: "L2",
    direction: 1,
    rows: Array.from({ length: P.lessonMinRows * 2 }, (_, i) => ({
      id: `r${i}`,
      regime: i % 2 === 0 ? "ON" : "OFF",
      value: 0.01,
      stressValue: 0.005,
      stressNet: 0.004,
      flagged: false,
      entryD: "2026-03-02",
      outcomeD: "2026-03-10",
    })),
    blocks: P.minBlocks,
    val110: { i: "pass", iv: "pass" },
    window: { startD: "2026-01-01", endD: "2026-06-30", testD: "2026-07-15" },
    params: [],
    l2: "pending",
  } as unknown as LessonSubject;
  return { evaluation: evaluateSubject(lesson, P), grade: "L2" };
}

describe("annotations never enter an LLM context (KB-051)", () => {
  it("the annotation is really stored", async () => {
    const r = await w.auth.execute("SELECT text FROM annotation WHERE text LIKE 'QX-%'");
    expect(r.rows).toHaveLength(1);
  });

  it("the context pack of the Critic does not contain it", () => {
    expect(JSON.stringify(packOf(subject()))).not.toContain("QX-annotation");
  });

  it("no prompt sent to a provider contains it", async () => {
    const seen: ProviderRequest[] = [];
    const inner = mockProvider({});
    const spy: LlmProvider = {
      ...inner,
      call: (req, signal) => {
        seen.push(req);
        return inner.call(req, signal);
      },
    };
    const providers = [spy];
    const rep = await wordConcerns(w.main, {
      market: "AU",
      d: "2026-10-06",
      runId: "kb051",
      params: AP,
      subjects: [subject()],
      providers,
      routerFor: (chain) =>
        makeRouter("mock", providers, undefined, { chain: { R3: chain } }).router,
    });
    expect(rep.worded).toBe(1);
    expect(seen.length).toBeGreaterThan(0); // a real prompt was built and sent
    for (const req of seen) {
      expect(req.prompt).not.toContain("QX-annotation");
      expect(req.prompt).not.toContain("sell everything");
    }
    const notes = await w.main.execute("SELECT text FROM critique_note");
    expect(JSON.stringify(notes.rows)).not.toContain("QX-annotation");
  });
});
