// @vitest-environment node
// KB renderers, document versions, mapping completeness and the review back-fill (M6 T13; KB-001..003,
// EML-015, AT-24). Synthetic ZZ records only.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { LEARNING_TABLES } from "@/lib/learning/schema";
import { buildAllDocuments, routeChange, syncDocuments } from "@/lib/kb/documents";
import {
  listRecordIds,
  mappingCompleteness,
  RECORD_SOURCES,
  UNMAPPED_TABLES,
} from "@/lib/kb/mapping";
import {
  contentSha,
  GRADE_VERB,
  renderFile,
  renderFrontMatter,
  renderHypothesis,
  statementOf,
  type DocFront,
  type RenderedDoc,
} from "@/lib/kb/render";
import { CHALLENGER, exec, kbWorld, LESSON, MARKET } from "./helpers";

afterEach(cleanupTempDbs);

const byPath = (docs: RenderedDoc[], p: string) => docs.find((d) => d.path === p);

describe("renderers", () => {
  it("writes the KB-003 front matter in a fixed order", () => {
    const f: DocFront = {
      id: "ZZ-1",
      market: "AU",
      type: "lesson",
      created: "2026-10-10",
      updated: "2026-10-14",
      version: 3,
      grade: "L1",
      related: ["b", "a"],
    };
    expect(renderFrontMatter(f)).toBe(
      '---\nid: "ZZ-1"\nmarket: "AU"\ntype: "lesson"\ncreated: "2026-10-10"\nupdated: "2026-10-14"\nversion: 3\ngrade: "L1"\nrelated: ["b", "a"]\n---\n\n',
    );
    expect(renderFrontMatter({ ...f, grade: null })).not.toContain("grade:");
    expect(renderFile(f, "body\n")).toMatch(/---\n\nbody\n$/);
  });

  it("content hash ignores the version number only", () => {
    const { version, ...rest } = {
      id: "x",
      market: "AU",
      type: "lesson" as const,
      created: "a",
      updated: "b",
      version: 1,
      grade: null,
      related: [],
    };
    expect(version).toBe(1);
    expect(contentSha(rest, "x")).toBe(contentSha({ ...rest }, "x"));
    expect(contentSha(rest, "x")).not.toBe(contentSha({ ...rest, updated: "c" }, "x"));
    expect(contentSha(rest, "x")).not.toBe(contentSha(rest, "y"));
  });

  it("never states more than the grade (KB-020)", () => {
    const base = { templateId: "T", metric: "m", direction: 1, subjectText: "ZZ subject" };
    expect(statementOf(base, "L0")).toContain("was observed");
    expect(statementOf(base, "L1")).toContain("may hold");
    expect(statementOf(base, "L2")).toContain("held in a later test");
    expect(statementOf(base, "L3")).toContain("was adopted");
    expect(statementOf(base, "retired")).toContain("was retired");
    for (const g of ["L0", "L1"]) {
      expect(statementOf(base, g)).not.toMatch(/adopted|held in a later test|proven|confirmed/);
    }
    expect(Object.keys(GRADE_VERB).sort()).toEqual(["L0", "L1", "L2", "L3", "retired"]);
  });

  it("renders the family, playbook, lesson, challenger, review and source register of the synthetic world", async () => {
    const db = await kbWorld();
    const docs = await buildAllDocuments(db);
    const paths = docs.map((d) => d.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(
      expect.arrayContaining([
        "knowledge/au/families/F1.md",
        "knowledge/au/families/F6.md",
        "knowledge/au/agent-playbooks/A1.md",
        `knowledge/au/lessons/${LESSON}.md`,
        `knowledge/au/challengers/${CHALLENGER}.md`,
        "knowledge/au/reviews/2026-10-13.md",
        "knowledge/au/reviews/2026-10-14.md",
        "knowledge/common/source-register.md",
      ]),
    );

    const fam = byPath(docs, "knowledge/au/families/F1.md")!;
    expect(fam.front).toMatchObject({
      id: "AU-F1",
      type: "family",
      created: "2026-10-01",
      grade: null,
    });
    expect(fam.body).toContain("## Hypothetical leverage");
    expect(fam.body).toContain("| Levered | 10x | 12 | 3 | 1 | 0 | -1500 |");
    expect(fam.body).toContain("| Reality-adjusted | 5x | 9 |");
    expect(fam.body).toContain("hypothetical leverage");
    expect(fam.body).toContain(`${LESSON} (L1)`);
    expect(fam.body).toContain(`${CHALLENGER} (replay)`);
    expect(fam.body).toContain("| F1.v2 | F1.v1 | challenger | 2026-10-12 | registered |");

    const lesson = byPath(docs, `knowledge/au/lessons/${LESSON}.md`)!;
    expect(lesson.front.grade).toBe("L1");
    expect(lesson.body).toContain("may hold");
    expect(lesson.body).not.toContain("was adopted");
    expect(lesson.body).toContain("bucket 3, sector ZZ Materials");
    expect(lesson.front.updated).toBe("2026-10-14");

    const ch = byPath(docs, `knowledge/au/challengers/${CHALLENGER}.md`)!;
    expect(ch.body).toMatch(/\| .* \| .* \| .* \|/);
    expect(ch.body).toContain("| 2 | proposed | replay | 2026-10-13 | A6 | queued for replay |");
    expect(ch.body).toContain("not passed");

    const pb = byPath(docs, "knowledge/au/agent-playbooks/A1.md")!;
    expect(pb.body).toContain("ZZ Materials bucket 3 may hold (L1).");

    const review = byPath(docs, "knowledge/au/reviews/2026-10-14.md")!;
    expect(review.body).toContain("(v2)");
    expect(review.body).not.toContain("(v1)");
    expect(review.body).toContain("Learning plan of the night");
    expect(review.sourceIds).toEqual(
      expect.arrayContaining(["evening_review:2026-10-14:1", "evening_review:2026-10-14:2"]),
    );

    const reg = byPath(docs, "knowledge/common/source-register.md")!;
    expect(reg.body).toContain("zz_source");
    expect(reg.body).not.toContain("secret-owner-ref");
    expect(reg.front.market).toBe("common");
  });

  it("is deterministic: the same records render the same bytes", async () => {
    const db = await kbWorld();
    const a = await buildAllDocuments(db);
    const b = await buildAllDocuments(db);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("renders a hypothesis from supplied fields", () => {
    const d = renderHypothesis({
      market: "AU",
      id: "H-1",
      title: "ZZ idea",
      text: "text  \n",
      created: "2026-10-01",
      updated: "2026-10-02",
      related: ["b", "a", "a"],
      sourceIds: [],
    });
    expect(d.path).toBe("knowledge/au/hypotheses/H-1.md");
    expect(d.front.related).toEqual(["a", "b"]);
    expect(d.body).toBe("# ZZ idea\n\ntext\n");
  });
});

describe("document versions", () => {
  it("writes version 1 for every document, then nothing until a record changes", async () => {
    const db = await kbWorld();
    const first = await syncDocuments(db, { d: "2026-10-17", now: "2026-10-17T12:00:00.000Z" });
    expect(first.written.length).toBeGreaterThan(8);
    expect(first.written.every((w) => w.version === 1)).toBe(true);
    const n = Number((await exec(db, "SELECT COUNT(*) AS n FROM document")).rows[0]!.n);
    expect(n).toBe(first.written.length);

    const again = await syncDocuments(db, { d: "2026-10-18", now: "2026-10-18T12:00:00.000Z" });
    expect(again.written).toEqual([]);
    expect(again.unchanged).toBe(first.written.length);
    expect(Number((await exec(db, "SELECT COUNT(*) AS n FROM document")).rows[0]!.n)).toBe(n);

    // A new grade changes the lesson (and the family that lists it), nothing else.
    await exec(
      db,
      `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, estimate, lower, upper, p,
         alpha_j, B, state_text, run_id, d)
       VALUES (?, 3, 'L2', 1, 'l2', 30, 6, 0.01, 0.001, 0.02, 0.01, 0.02, 1000, '', 'run-4', '2026-10-18')`,
      [LESSON],
    );
    const third = await syncDocuments(db, { d: "2026-10-18", now: "2026-10-18T13:00:00.000Z" });
    expect(third.written.map((w) => w.path).sort()).toEqual([
      "knowledge/au/families/F1.md",
      `knowledge/au/lessons/${LESSON}.md`,
    ]);
    expect(third.written.every((w) => w.version === 2)).toBe(true);
    const row = (
      await exec(db, "SELECT front_json, d FROM document WHERE path = ? AND version = 2", [
        `knowledge/au/lessons/${LESSON}.md`,
      ])
    ).rows[0]!;
    expect(JSON.parse(String(row.front_json))).toMatchObject({
      version: 2,
      grade: "L2",
      updated: "2026-10-18",
    });
    expect(String(row.d)).toBe("2026-10-18");
  });

  it("refuses to rewrite a stored version (append-only)", async () => {
    const db = await kbWorld();
    await syncDocuments(db, { d: "2026-10-17", now: "2026-10-17T12:00:00.000Z" });
    await expect(exec(db, "UPDATE document SET body = 'x'")).rejects.toThrow();
    await expect(exec(db, "DELETE FROM document")).rejects.toThrow();
  });
});

describe("mapping completeness", () => {
  it("every mapped record of the world is carried by a regenerated document", async () => {
    const db = await kbWorld();
    const r = await mappingCompleteness(db, MARKET);
    expect(r.missing).toEqual([]);
    expect(r.records).toBeGreaterThan(25);
    // Per day too (AT-24 "every record of D").
    for (const d of ["2026-10-10", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
      expect((await mappingCompleteness(db, MARKET, d)).missing).toEqual([]);
    }
    const ids = await listRecordIds(db, MARKET, "2026-10-14");
    expect(ids).toEqual(
      expect.arrayContaining([
        `lesson_grade:${LESSON}:2`,
        "change_ledger:1",
        "playbook_version:A1:1",
        "plan_item:AU:2026-10-14:1",
        "evening_review:2026-10-14:2",
        `critique:lesson:${LESSON}:run-2`,
      ]),
    );
  });

  it("reports a record that no document carries", async () => {
    const db = await kbWorld();
    // A change that names nothing routable.
    await exec(
      db,
      `INSERT INTO change_ledger (market, kind, target, lesson_ids_json, effective_d, actor, created_at)
       VALUES (?, 'retire', 'unknown-target', '[]', '2026-10-16', 'A6', '2026-10-16T10:00:00.000Z')`,
      [MARKET],
    );
    const r = await mappingCompleteness(db, MARKET);
    expect(r.missing).toEqual(["change_ledger:5"]);
  });

  it("routes change rows by challenger, lesson, playbook or family", () => {
    expect(routeChange({ target: "A6", challengerId: null, lessonIds: [] })).toEqual([
      { kind: "playbook", agent: "A6" },
    ]);
    // the target Lane A really writes (D-118): `playbook/<agent>`
    expect(routeChange({ target: "playbook/A2", challengerId: null, lessonIds: ["L-1"] })).toEqual([
      { kind: "lesson", id: "L-1" },
      { kind: "playbook", agent: "A2" },
    ]);
    expect(routeChange({ target: "F3", challengerId: null, lessonIds: [] })).toEqual([
      { kind: "family", family: "F3" },
    ]);
    expect(routeChange({ target: "F1.v2", challengerId: "C-1", lessonIds: ["L-1"] })).toEqual([
      { kind: "challenger", id: "C-1" },
      { kind: "lesson", id: "L-1" },
    ]);
    expect(routeChange({ target: "nothing", challengerId: null, lessonIds: [] })).toEqual([]);
  });

  it("every learning table is either mapped or explained (a new writer must choose)", () => {
    const mapped = new Set(RECORD_SOURCES.map((s) => s.table));
    const unmapped = new Set(Object.keys(UNMAPPED_TABLES));
    for (const t of Object.values(LEARNING_TABLES)) {
      expect(mapped.has(t) || unmapped.has(t), t).toBe(true);
      expect(mapped.has(t) && unmapped.has(t), t).toBe(false);
    }
    for (const reason of Object.values(UNMAPPED_TABLES)) expect(reason.length).toBeGreaterThan(8);
  });
});

describe("review back-fill (EML-015, decision 31)", () => {
  it("the first sync writes a review document for every stored date, the latest version each", async () => {
    const db = await kbWorld();
    await exec(
      db,
      `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
       VALUES ('2026-09-01', 1, 'non_trading', '{}', ?, '', '', '# old review', 0, 'rules', '2026-09-01T09:00:00.000Z')`,
      ["9".repeat(64)],
    );
    const res = await syncDocuments(db, { d: "2026-10-17", now: "2026-10-17T12:00:00.000Z" });
    const reviews = res.written.filter((w) => w.path.includes("/reviews/")).map((w) => w.path);
    expect(reviews).toEqual([
      "knowledge/au/reviews/2026-09-01.md",
      "knowledge/au/reviews/2026-10-13.md",
      "knowledge/au/reviews/2026-10-14.md",
    ]);
    const body = String(
      (
        await exec(
          db,
          "SELECT body FROM document WHERE path = 'knowledge/au/reviews/2026-09-01.md'",
        )
      ).rows[0]!.body,
    );
    expect(body).toContain("# old review");
  });
});
