// @vitest-environment node
// AT-24 KB archive (M6 T18; KB-001...003, PLT-022a, EML-015, AT-05a). Verbatim: "Every record of the day
// has a regenerated markdown document in the private data repo (never the code repo; no deployment
// triggered)". The real renderers, document versions and archive script against an in-process fake
// GitHub (no network), over the synthetic KB world plus a real `learn` night. Heavier cover (named, not
// repeated): tests/kb/documents.test.ts, tests/kb/archive.test.ts, tests/learning/learnNights.test.ts,
// tests/time/m6Jobs.test.ts (the 22:15 slot on the clock-change days).
// PENDING (Owner / production, not evidenced here): the Owner approval of kb-archive.yml; the use of the
// data-repo token; confirmation that the data repo has no Vercel project and no workflows; the Worker slot
// `kb-archive` is disabled; production evidence once the Owner enables it and one real run is checked.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AU_SLOTS } from "../../../worker/src/schedule";
import { archiveRun, pathAllowed } from "@/lib/kb/archiveCli";
import { buildAllDocuments, syncDocuments } from "@/lib/kb/documents";
import { createGitDataClient, gitBlobSha } from "@/lib/kb/gitData";
import { mappingCompleteness } from "@/lib/kb/mapping";
import { renderFile, type DocFront } from "@/lib/kb/render";
import { learnDay } from "@/lib/learning/learnStage";
import { cleanupTempDbs } from "../../db/helpers";
import { fakeGithub, REPO, TOKEN } from "../../kb/fakeGithub";
import { LESSON, MARKET, exec, kbWorld } from "../../kb/helpers";
import { PARAMS, addNight, seedLesson } from "../../learning/learnHelpers";

const D = "2026-10-20";
let tick = 0;
/** A distinct 22:15 Melbourne instant per run (the run id is the start time). */
const nextNow = (): Date => new Date(Date.UTC(2026, 9, 20, 11, 15, 0) + (tick += 1) * 3_600_000);
const WORKFLOW = readFileSync(
  path.resolve(__dirname, "../../../.github/workflows/kb-archive.yml"),
  "utf8",
);

let db: Client;
beforeAll(async () => {
  db = await kbWorld();
  // a real A6 night on top of the synthetic records: Lane A writes a playbook, the ledger and the plan
  await exec(db, "UPDATE market SET mode = 'full' WHERE code = ?", [MARKET]);
  await addNight(db, D);
  await seedLesson(db, "L-night", "L2", { critic: true, d: D });
  const r = await learnDay(db, {
    market: MARKET,
    d: D,
    now: () => `${D}T08:20:00.000Z`,
    params: PARAMS,
  });
  expect(["success", "degraded"]).toContain(r.status);
});
afterAll(cleanupTempDbs);

const client = (gh: ReturnType<typeof fakeGithub>) =>
  createGitDataClient({ repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl });

describe("AT-24 every record of the day has a regenerated markdown document", () => {
  it("each record of the learning night and of the earlier days maps to a regenerated document (mapping completeness)", async () => {
    for (const d of ["2026-10-10", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", D]) {
      expect((await mappingCompleteness(db, MARKET, d)).missing, d).toEqual([]);
    }
    const all = await mappingCompleteness(db, MARKET);
    expect(all.missing).toEqual([]);
    expect(all.records).toBeGreaterThan(30);
  });

  it("documents carry the KB-003 front matter and a version that grows only when a record changes", async () => {
    const first = await syncDocuments(db, { d: D, now: `${D}T11:00:00.000Z` });
    expect(first.written.length).toBeGreaterThan(8);
    const stored = await exec(db, "SELECT path, front_json FROM document WHERE version = 1");
    for (const r of stored.rows) {
      const f = JSON.parse(String(r.front_json)) as DocFront;
      expect(Object.keys(f).sort()).toEqual(
        ["created", "grade", "id", "market", "related", "type", "updated", "version"].sort(),
      );
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.market.length).toBeGreaterThan(0);
      expect(Array.isArray(f.related)).toBe(true);
    }
    const again = await syncDocuments(db, { d: D, now: `${D}T11:05:00.000Z` });
    expect(again.written).toEqual([]);
    // the lesson document states a grade and the first line of the file is the front matter
    const lessonDoc = (await buildAllDocuments(db)).find((x) => x.path.includes(LESSON))!;
    expect(lessonDoc.front.grade).toMatch(/^L[0-3]$/);
    expect(
      renderFile({ ...lessonDoc.front, version: 1 }, lessonDoc.body).startsWith("---\nid: "),
    ).toBe(true);
  });
});

describe("AT-24 the archive goes to the private data repo only, with no deployment", () => {
  it("one fast-forward commit of the changed files under knowledge/, then a re-run makes no commit", async () => {
    const gh = fakeGithub();
    const git = client(gh);
    const heads = gh.commitCount();
    const r1 = await archiveRun({ db, git, now: nextNow() });
    expect(r1.status).toBe("ok");
    expect(r1.filesChanged).toBeGreaterThan(8);
    expect(gh.commitCount()).toBe(heads + 1);
    expect(gh.refUpdates.every((u) => (u as { force: boolean }).force === false)).toBe(true);
    for (const f of gh.files().keys()) expect(f === "README.md" || pathAllowed(f), f).toBe(true);
    const r2 = await archiveRun({ db, git, now: nextNow() });
    expect(r2).toMatchObject({ status: "ok", filesChanged: 0, commitSha: null });
    expect(gh.commitCount()).toBe(heads + 1);
  });

  it("every request goes to api.github.com for the data repo; none to the code repo, Vercel, workflows or deployments", async () => {
    const gh = fakeGithub();
    await archiveRun({ db, git: client(gh), now: nextNow() });
    expect(gh.requests.length).toBeGreaterThan(5);
    for (const q of gh.requests) {
      expect(
        q.url.startsWith(`https://api.github.com/repos/${REPO}/git/`) ||
          q.url === `https://api.github.com/repos/${REPO}`,
      ).toBe(true);
      expect(q.auth).toBe(`Bearer ${TOKEN}`);
      expect(q.url).not.toMatch(/dispatches|actions|deployments|vercel|releases|contents/);
    }
    // the code repo cannot even be configured: only <owner>/<name>-data is accepted
    expect(() => createGitDataClient({ repo: "zz-owner/praxis-app", token: TOKEN })).toThrow();
  });

  it("archived bytes equal the markdown regenerated from the database", async () => {
    const gh = fakeGithub();
    await archiveRun({ db, git: client(gh), now: nextNow() });
    const files = gh.files();
    const docs = await exec(
      db,
      `SELECT path, front_json, body FROM document d
        WHERE version = (SELECT MAX(version) FROM document WHERE path = d.path)`,
    );
    expect(docs.rows.length).toBe(files.size - 1);
    for (const r of docs.rows) {
      const bytes = renderFile(JSON.parse(String(r.front_json)) as DocFront, String(r.body));
      expect(gh.blob(files.get(String(r.path))!)).toBe(bytes);
      expect(gitBlobSha(Buffer.from(bytes))).toBe(files.get(String(r.path)));
    }
    // and the stored bodies are what the renderers produce from the records today
    const fresh = await buildAllDocuments(db);
    for (const f of fresh) {
      const row = docs.rows.find((x) => x.path === f.path)!;
      expect(String(row.body)).toBe(f.body);
    }
    // every stored review date has its document (back-fill, EML-015)
    expect([...files.keys()].filter((k) => k.includes("/reviews/")).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("kb-archive.yml is dispatch-only, reads the secrets in one step and uploads nothing; the Worker slot is disabled", () => {
    const code = WORKFLOW.split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).toMatch(/^on: workflow_dispatch$/m);
    expect(code).not.toMatch(/^\s*schedule:/m);
    expect(code).not.toMatch(/\bpush:|pull_request/);
    expect(code).not.toMatch(/upload-artifact|actions\/cache|vercel/i);
    // the data repo secret appears once, in the archive step only
    expect(code.match(/DATA_REPO_TOKEN_PROD/g)).toHaveLength(1);
    expect(code).toContain("DATA_REPO: ${{ github.repository }}-data");
    const slot = AU_SLOTS.find((s) => s.id === "kb-archive")!;
    expect(slot).toMatchObject({ workflow: "kb-archive.yml", enabled: false });
  });
});
