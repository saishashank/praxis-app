// @vitest-environment node
// M8 T5 (D-147, DAT-124): the T8 knowledge MODEL itself carries no exact YYYY-MM-DD date for a masked
// user (ISO weeks instead), in lessons, challengers, documents (path, front matter, text) and the plan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, type Who } from "../loaders/world";
import { loadKnowledge, weekify, weekifyText } from "@/lib/ui/loaders/knowledge";
import { dayText } from "@/lib/ui/loaders/knowledgeViews";
import { knowledgeWorld, type KnowledgeWorld } from "../learned/seed";

afterAll(cleanupTempDbs);
let w: KnowledgeWorld;
beforeAll(async () => {
  w = await knowledgeWorld();
  // a document whose path, front matter and text carry exact dates
  await w.main.execute({
    sql: `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha, d, created_at)
          VALUES ('knowledge/au/lessons/2026-10-02-note.md', 1, 'AU', 'lesson',
            '{"title":"Seen on 2026-10-02","when":"2026-10-03T01:00:00Z"}', 'See 2026-10-04.', ?,
            '2026-10-02', '2026-10-02T09:00:00.000Z')`,
    args: ["c".repeat(64)],
  });
});

const ISO_DAY = /\d{4}-\d{2}-\d{2}/;
const MASKED: Who[] = ["editor", "viewer"];

describe("masked knowledge model (D-147)", () => {
  it("has no exact date anywhere, and still has content", async () => {
    for (const who of MASKED) {
      const m = await loadKnowledge(envOf(w, who), {});
      expect(m.state).toBe("ok");
      expect(m.lessons.length).toBeGreaterThan(0);
      expect(m.challengers.length).toBeGreaterThan(0);
      expect(m.documents.length).toBeGreaterThan(0);
      expect(JSON.stringify(m)).not.toMatch(ISO_DAY);
      expect(JSON.stringify(m)).toMatch(/\d{4}-W\d{2}/);
    }
  });

  it("the Owner and a granted viewer still see the stored dates", async () => {
    for (const who of ["owner", "granted"] as Who[]) {
      const m = await loadKnowledge(envOf(w, who), {});
      expect(JSON.stringify(m)).toMatch(ISO_DAY);
    }
  });

  it("weekify turns every date in strings and keys into its ISO week, leaving other values alone", () => {
    expect(weekifyText("on 2026-10-19T01:00Z and 2026-02-31")).toBe(
      "on 2026-W43T01:00Z and a date",
    );
    expect(weekify({ "2026-10-19": ["x 2026-10-19", 5, true, null] })).toEqual({
      "2026-W43": ["x 2026-W43", 5, true, null],
    });
  });

  it("the page helper accepts an already-converted week", () => {
    expect(dayText("2026-W43", true)).toBe("2026-W43");
    expect(dayText("2026-10-19", true)).toBe("2026-W43");
    expect(dayText("2026-10-19", false)).not.toMatch(/W43/);
  });
});
