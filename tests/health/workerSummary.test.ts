// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOBS } from "@/lib/health/jobs";
import { getHealthSummary } from "@/lib/health/summary";
import { recordWorkerReport } from "@/lib/workerReport/record";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const results = [
  { name: "TURSO_MAIN round trip", ok: true, detail: "create/insert/select/drop ok" },
  { name: "GITHUB_DISPATCH_TOKEN", ok: false, detail: "HTTP 401" },
  { name: "WORKER_HMAC_SECRET", ok: true, detail: "signed report accepted" },
];

describe("Worker self-check on System Health", () => {
  it("is a known daily job", () => {
    expect(JOBS.find((j) => j.job === "worker-selfcheck")).toMatchObject({
      label: "Worker self-check",
      expectedIntervalSec: 86_400,
    });
  });
  it("owner sees per-secret Worker results next to the Vercel ones; others see none", async () => {
    await recordWorkerReport(db, { commit: "unknown", results });
    const now = new Date();
    const owner = await getHealthSummary(db, now, "owner");
    expect(owner.workerSecrets?.results).toEqual([
      {
        name: "TURSO_MAIN round trip",
        ok: true,
        pending: false,
        detail: "create/insert/select/drop ok",
      },
      { name: "GITHUB_DISPATCH_TOKEN", ok: false, pending: false, detail: "HTTP 401" },
      { name: "WORKER_HMAC_SECRET", ok: true, pending: false, detail: "signed report accepted" },
    ]);
    expect(owner.workerSecrets?.lastVerifiedAt).toEqual(expect.any(String));
    expect(owner.secrets?.results).toEqual([]); // the Vercel report is separate
    const job = owner.jobs.find((j) => j.job === "worker-selfcheck")!;
    expect(job).toMatchObject({ state: "failed", errorSummary: "1 check(s) failed" });
    for (const role of ["editor", "viewer"] as const) {
      const s = await getHealthSummary(db, now, role);
      expect("workerSecrets" in s).toBe(false);
      expect("errorSummary" in s.jobs.find((j) => j.job === "worker-selfcheck")!).toBe(false);
    }
  });
  it("no report yet: job is 'no data' with a note and the Owner list is empty", async () => {
    const s = await getHealthSummary(db, new Date(), "owner");
    expect(s.jobs.find((j) => j.job === "worker-selfcheck")).toMatchObject({
      state: "no data",
      stale: false,
    });
    expect(s.jobs.find((j) => j.job === "worker-selfcheck")!.note).toBeTruthy();
    expect(s.workerSecrets).toEqual({ lastVerifiedAt: null, results: [] });
  });
  it("a success older than twice the interval is stale", async () => {
    await recordWorkerReport(db, {
      commit: "unknown",
      results: results.map((r) => ({ ...r, ok: true })),
    });
    const later = new Date(Date.now() + 2 * 86_400_000 + 60_000);
    expect(
      (await getHealthSummary(db, later, "viewer")).jobs.find((j) => j.job === "worker-selfcheck")!
        .state,
    ).toBe("stale");
  });
});
