// @vitest-environment node
// KB mirror of the expert data (M13-lite WP7; D-523, D-641; AT-41 completeness clause): paths under
// knowledge/common, doc_type hypothesis, no red-flag text, no licence detail, no audience, idempotent sync,
// mapping completeness. Synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExpertDocuments } from "@/lib/experts/kbDocs";
import { syncExpertDocs } from "@/lib/experts/weeklyStage";
import { buildAllDocuments } from "@/lib/kb/documents";
import { pathAllowed } from "@/lib/kb/archiveCli";
import { listRecordIds, mappingCompleteness } from "@/lib/kb/mapping";
import { renderFile } from "@/lib/kb/render";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addOutcome, addProposal, addScreening, importZzSeed } from "./zzWorld";

afterAll(cleanupTempDbs);

let db: Client;
beforeAll(async () => {
  db = await freshDb("main");
  await importZzSeed(db);
  await addScreening(db, { market: "AU", d: "2030-03-01", clusterIds: ["K-ZZ1", "K-ZZ2"] });
  await addProposal(db, { market: "AU", d: "2030-03-01", clusterId: "K-ZZ1", status: "refused" });
  await addOutcome(db);
});

describe("buildExpertDocuments", () => {
  it("is empty for a world without expert data (nothing new reaches the KB)", async () => {
    const empty = await freshDb("main");
    expect(await buildExpertDocuments(empty)).toEqual([]);
    expect((await buildAllDocuments(empty)).filter((d) => d.path.includes("/experts/"))).toEqual(
      [],
    );
  });

  it("renders one document per expert and cluster plus the gap report, under knowledge/common", async () => {
    const docs = await buildExpertDocuments(db);
    const paths = docs.map((d) => d.path);
    expect(paths.filter((p) => p.startsWith("knowledge/common/experts/X-ZZ"))).toHaveLength(6);
    expect(paths.filter((p) => p.startsWith("knowledge/common/techniques/K-ZZ"))).toHaveLength(5);
    expect(paths).toContain("knowledge/common/experts/vocabulary-gaps.md");
    expect(paths).toEqual([...paths].sort());
    for (const d of docs) {
      expect(pathAllowed(d.path), d.path).toBe(true); // the archive allow-list accepts every path
      expect(d.front.type).toBe("hypothesis");
      expect(d.front.market).toBe("common");
    }
  });

  it("carries no red-flag text, no licence detail and no audience figure (readable by every role)", async () => {
    const docs = await buildExpertDocuments(db);
    const text = docs.map((d) => renderFile({ ...d.front, version: 1 }, d.body)).join("\n");
    expect(text).not.toContain("synthetic caveat"); // the red-flag text of X-ZZ2
    expect(text).not.toContain("zz2.example.test/caveat"); // and its source link
    expect(text.toLowerCase()).not.toMatch(
      /red flag|licen[cs]e|registered|audience|followers|12000|12,000/,
    );
    // the claim wording of a source never appears either: counts by status only
    expect(text).not.toContain("ZZ synthetic claim");
    const x1 = docs.find((d) => d.path.endsWith("/X-ZZ1.md"))!;
    expect(x1.body).toContain("# ZZ Expert 1");
    expect(x1.body).toContain("## Claims by status");
    expect(x1.body).toContain("https://zz1.example.test/post-1");
  });

  it("states the screening result descriptively, never as a forecast", async () => {
    const docs = await buildExpertDocuments(db);
    const k1 = docs.find((d) => d.path.endsWith("/K-ZZ1.md"))!;
    expect(k1.body).toContain("passed (grade L1, may hold)");
    expect(k1.body).toContain("Development split only; not a forecast.");
    expect(k1.body).toContain("Latest proposal 2030-03-01: challenger refused");
    expect(k1.front.grade).toBe("L1");
    const k2 = docs.find((d) => d.path.endsWith("/K-ZZ2.md"))!;
    expect(k2.body).toContain("did not pass (grade L0, was observed)");
    expect(k2.front.grade).toBe("L0");
    const k3 = docs.find((d) => d.path.endsWith("/K-ZZ3.md"))!;
    expect(k3.body).toContain("Not screened yet.");
    expect(k3.front.grade).toBeNull();
  });

  it("the expert scorecard line says 'not enough tested claims' below the threshold", async () => {
    const docs = await buildExpertDocuments(db);
    const x1 = docs.find((d) => d.path.endsWith("/X-ZZ1.md"))!;
    expect(x1.body).toContain("not enough tested claims");
  });

  it("the gap report lists the missing inputs as sentences", async () => {
    const docs = await buildExpertDocuments(db);
    const gaps = docs.find((d) => d.path.endsWith("/vocabulary-gaps.md"))!;
    expect(gaps.body).toMatch(/\d+ experts? (relies|rely) on zz missing input \(not in Praxis\)/);
  });

  it("is deterministic: two builds are identical", async () => {
    expect(await buildExpertDocuments(db)).toEqual(await buildExpertDocuments(db));
  });
});

describe("syncExpertDocs and mapping completeness", () => {
  it("writes each document once (by content hash) and a rerun writes nothing", async () => {
    const first = await syncExpertDocs(db, { d: "2030-03-02", now: "2030-03-02T00:00:00.000Z" });
    expect(first.written).toBe(12);
    expect(first.unchanged).toBe(0);
    const rows = await db.execute(
      "SELECT DISTINCT doc_type, market FROM document WHERE path LIKE 'knowledge/common/experts/%' OR path LIKE 'knowledge/common/techniques/%'",
    );
    expect(rows.rows.map((r) => ({ ...r }))).toEqual([
      { doc_type: "hypothesis", market: "common" },
    ]);
    const second = await syncExpertDocs(db, { d: "2030-03-09", now: "2030-03-09T00:00:00.000Z" });
    expect(second).toEqual({ written: 0, unchanged: 12 });
    expect(Number((await db.execute("SELECT MAX(version) AS v FROM document")).rows[0]!.v)).toBe(1);
  });

  it("a changed record writes a new version of its own document only", async () => {
    await db.execute(
      "INSERT INTO claim_status (claim_id, seq, status, reason, actor, at) VALUES ('C-ZZ-001', 2, 'owner_checked', NULL, 'u1', '2030-03-10T00:00:00.000Z')",
    );
    const r = await syncExpertDocs(db, { d: "2030-03-10", now: "2030-03-10T00:00:00.000Z" });
    expect(r.written).toBe(1);
    const v2 = await db.execute("SELECT path FROM document WHERE version = 2");
    expect(v2.rows.map((x) => String(x.path))).toEqual(["knowledge/common/experts/X-ZZ1.md"]);
  });

  it("every expert and cluster record is carried by a document (completeness is green)", async () => {
    const ids = await listRecordIds(db, "AU");
    expect(ids.filter((i) => i.startsWith("expert:"))).toHaveLength(6);
    expect(ids.filter((i) => i.startsWith("cluster:"))).toHaveLength(5);
    const c = await mappingCompleteness(db, "AU");
    expect(c.missing).toEqual([]);
    expect(c.records).toBeGreaterThanOrEqual(11);
  });

  it("an expert id the archive path would refuse is reported missing, not silently dropped", async () => {
    const w = await freshDb("main");
    await w.execute({
      sql: "INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES ('X ZZ 9', 'ZZ Odd', 'tracked', 'core', ?, ?)",
      args: ["2030-02-01T00:00:00.000Z", "2030-02-01T00:00:00.000Z"],
    });
    expect((await mappingCompleteness(w, "AU")).missing).toEqual(["expert:X ZZ 9"]);
  });
});
