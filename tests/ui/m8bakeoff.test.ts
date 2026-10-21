// @vitest-environment node
// M8 T5 (LLM-042): the stored bake-off results are loadable for /usage (Owner only), newest run only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertBakeoffRows, type BakeoffRow } from "@/lib/llm/bakeoff";
import { loadBakeoffResults } from "@/lib/ui/loaders/usageBakeoff";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const row = (runId: string, model: string, category: BakeoffRow["category"], pass: 0 | 1) =>
  ({
    runId,
    modelId: model,
    category,
    items: 12,
    jsonValidPct: 99,
    inventedNumbers: 0,
    injectionResistancePct: 100,
    detectionPct: null,
    triageAgreementPct: category === "triage" ? 88 : null,
    passes: pass,
    reportSha: "a".repeat(64),
    trainsOnPromptsCheckedD: pass === 1 ? "2026-10-01" : null,
  }) satisfies BakeoffRow;

describe("bake-off results on /usage", () => {
  it("no run yet reads null; non-Owners get nothing", async () => {
    expect(await loadBakeoffResults(db, "owner")).toBeNull();
    await insertBakeoffRows(db, [row("bakeoff-2026-10-01-aaaaaaaa", "m1", "triage", 1)]);
    expect(await loadBakeoffResults(db, "editor")).toBeNull();
    expect(await loadBakeoffResults(db, null)).toBeNull();
  });

  it("returns the newest run with pass flags and the dated trains_on_prompts check", async () => {
    await insertBakeoffRows(db, [
      row("bakeoff-2026-09-01-aaaaaaaa", "old", "triage", 1),
      row("bakeoff-2026-10-01-bbbbbbbb", "m1", "triage", 1),
      row("bakeoff-2026-10-01-bbbbbbbb", "m1", "overall", 0),
    ]);
    const v = await loadBakeoffResults(db, "owner");
    expect(v?.runId).toBe("bakeoff-2026-10-01-bbbbbbbb");
    expect(v?.reportSha).toBe("a".repeat(64));
    expect(v?.lines.map((l) => `${l.modelId}:${l.category}:${l.passes}`)).toEqual([
      "m1:overall:false",
      "m1:triage:true",
    ]);
    expect(v?.lines[1]).toMatchObject({
      triageAgreementPct: 88,
      trainsOnPromptsCheckedD: "2026-10-01",
    });
  });
});
