// @vitest-environment node
// The polling line of the experts health line (M22 E2; KB-082): plain words, nothing when the job has never run, an attention
// state when a source was refused or half the sources failed. Read-only; never throws.
import { afterEach, describe, expect, it } from "vitest";
import { loadExpertsHealth, pollingLineOf } from "@/lib/health/experts";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("pollingLineOf", () => {
  it("is nothing when the job has never run", () => {
    expect(pollingLineOf(null)).toBeNull();
  });

  it("reads the last run in plain words", () => {
    const l = pollingLineOf({
      d: "2030-03-05",
      counts: { new: 12, sources: 8, notAllowed: 3, failed: 1, refused: 0 },
    });
    expect(l).toEqual({
      text: "Reading experts: last read 2030-03-05, 12 new headlines from 8 sources, 3 sources not allowed, 1 source could not be read.",
      warning: null,
    });
  });

  it("uses singular words and leaves out what is zero", () => {
    expect(pollingLineOf({ d: "2030-03-05", counts: { new: 1, sources: 1 } })?.text).toBe(
      "Reading experts: last read 2030-03-05, 1 new headline from 1 source.",
    );
  });

  it("warns when a request was refused or half of the sources failed", () => {
    expect(pollingLineOf({ d: "d", counts: { sources: 10, refused: 2 } })?.warning).toMatch(
      /refused/,
    );
    expect(pollingLineOf({ d: "d", counts: { sources: 4, failed: 2 } })?.warning).not.toBeNull();
    expect(pollingLineOf({ d: "d", counts: { sources: 4, failed: 1 } })?.warning).toBeNull();
  });

  it("says when the daily limit is zero", () => {
    expect(pollingLineOf({ d: "d", counts: { off: 1 } })?.text).toBe(
      "Reading experts: switched off (the daily limit is zero).",
    );
  });

  it("carries no job code, host or name", () => {
    const t = pollingLineOf({ d: "2030-03-05", counts: { new: 2, sources: 2 } })!.text;
    expect(t).not.toMatch(/R1|R2|KB-|D-\d|https?:|example/);
  });
});

describe("loadExpertsHealth with a poll run", () => {
  it("leaves the line as it was before the job ever ran, then appends the polling line", async () => {
    const db = await freshDb("main");
    const before = await loadExpertsHealth(db, "AU");
    expect(before.text).toBe(
      "Experts: 0 claims to check; last screening none yet; 0 clusters parked.",
    );
    await db.execute({
      sql: "INSERT INTO expert_poll_run (kind, d, counts_json, created_at) VALUES ('poll', '2030-03-05', ?, '2030-03-05T09:00:00.000Z')",
      args: [JSON.stringify({ new: 4, sources: 2, refused: 1 })],
    });
    const after = await loadExpertsHealth(db, "AU");
    expect(after.text).toContain(
      `${before.text} Reading experts: last read 2030-03-05, 4 new headlines from 2 sources, 1 request refused.`,
    );
    expect(after.state).toBe("attention");
    expect(after.warnings).toEqual(["some expert sources could not be read or were refused"]);
  });
});
