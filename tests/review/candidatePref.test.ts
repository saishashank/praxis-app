// M17 WP4/EML-042: the Evening Review's optional candidate section follows the Owner's
// `intraday_candidate_emails` (D-452: stored only once chosen; absent or unreadable = on).
import type { Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { ownerCandidatesOn } from "@/lib/review/routeHandler";

const authWith = (rows: { prefs_json: string | null }[] | Error) => () =>
  ({
    execute: async () => {
      if (rows instanceof Error) throw rows;
      return { rows };
    },
  }) as unknown as Client;

describe("ownerCandidatesOn", () => {
  it("is on with no auth database, no stored preference or an unreadable one", async () => {
    expect(await ownerCandidatesOn(undefined)).toBe(true);
    expect(await ownerCandidatesOn(authWith([]))).toBe(true);
    expect(await ownerCandidatesOn(authWith([{ prefs_json: null }]))).toBe(true);
    expect(await ownerCandidatesOn(authWith([{ prefs_json: "{not json" }]))).toBe(true);
    expect(await ownerCandidatesOn(authWith(new Error("down")))).toBe(true);
  });

  it("follows the Owner's choice", async () => {
    const on = JSON.stringify({ intraday_candidate_emails: "on" });
    const off = JSON.stringify({ intraday_candidate_emails: "off" });
    expect(await ownerCandidatesOn(authWith([{ prefs_json: on }]))).toBe(true);
    expect(await ownerCandidatesOn(authWith([{ prefs_json: off }]))).toBe(false);
  });
});
