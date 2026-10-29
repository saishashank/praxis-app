// @vitest-environment node
// DAT-234, DAT-236, FAM-006, AT-02: the Data files upload actions on /config. Owner only, a
// confirmation box, audit first, append-only data, and a refused file changes nothing.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbs = vi.hoisted(() => ({ main: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main(), authDb: () => dbs.auth() }));

import {
  uploadIndexChangesAction,
  uploadIndustryMapAction,
  uploadUniverseAction,
} from "@/app/(app)/config/actions";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
const CONFIRM = "upload_reference_file";
const form = (csv: string | null, confirm: string | null = CONFIRM) => {
  const f = new FormData();
  if (csv !== null) f.set("file", new File([csv], "x.csv", { type: "text/csv" }));
  if (confirm !== null) f.set("confirm", confirm);
  return f;
};
const IDX = "code,index,change,announced,effective,source\nZZA,X,add,2026-03-06,2026-03-23,s\n";
const count = async (db: Client, table: string) =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  dbs.main.mockReset().mockReturnValue(main);
  dbs.auth.mockReset().mockReturnValue(auth);
  const id = await addUser(auth, { email: "owner@example.test", role: "owner" });
  requireUser.mockResolvedValue({ id, email: "owner@example.test", name: null, role: "owner" });
});

describe("Data files uploads", () => {
  it("require admin on /config and write nothing when refused", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(uploadIndexChangesAction(form(IDX))).rejects.toThrow(/403/);
    expect(requireUser).toHaveBeenCalledWith("admin", "/config");
    expect(await count(main, "index_change")).toBe(0);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("need the confirmation box and a file", async () => {
    expect(await uploadIndexChangesAction(form(IDX, null))).toEqual({ error: "confirm_required" });
    expect(await uploadIndexChangesAction(form(IDX, "yes"))).toEqual({ error: "confirm_required" });
    expect(await uploadIndexChangesAction(form(null))).toEqual({ error: "invalid" });
    expect(await uploadIndexChangesAction(form(""))).toMatchObject({ error: "invalid" });
    expect(await count(main, "index_change")).toBe(0);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("load index changes, audit counts only, and revalidate; a repeat adds nothing", async () => {
    const r = await uploadIndexChangesAction(form(IDX));
    expect(r).toMatchObject({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/config");
    expect(await count(main, "index_change")).toBe(1);
    const rows = await auditRows(auth);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "reference_file.upload", target_id: "index_changes" });
    expect(rows[0].detail).toEqual({ kind: "index_changes", bytes: IDX.length });
    expect(JSON.stringify(rows[0])).not.toContain("ZZA");
    const again = await uploadIndexChangesAction(form(IDX));
    expect(again).toMatchObject({ ok: true, message: expect.stringContaining("0 new") });
    expect(await count(main, "index_change")).toBe(1);
  });

  it("refuse a bad file with the line number and load nothing", async () => {
    const bad = IDX + "ZZB,X,add,,2026-02-30,s\n";
    const r = await uploadIndexChangesAction(form(bad));
    expect(r).toMatchObject({ error: "invalid", message: expect.stringContaining("line 3") });
    expect(await count(main, "index_change")).toBe(0);
  });

  it("load the industry map as source manual", async () => {
    const r = await uploadIndustryMapAction(form("code,industry,as_of\nZZA,Gold,2026-01-01\n"));
    expect(r).toMatchObject({ ok: true });
    const row = (await main.execute("SELECT source, industry FROM instrument_class")).rows[0];
    expect(row).toMatchObject({ source: "manual", industry: "Gold" });
  });

  it("send the universe fallback through the importer and record source manual", async () => {
    expect(await uploadUniverseAction(form("not a listed companies file"))).toMatchObject({
      error: "invalid",
    });
    const csv = "Company name,ASX code,GICS industry group\nZed A,ZZA,Gold\nZed B,ZZB,Banks\n";
    const r = await uploadUniverseAction(form(csv));
    expect(r).toMatchObject({ ok: true });
    expect(
      (
        await main.execute("SELECT code FROM instrument WHERE market = 'AU' ORDER BY code")
      ).rows.map((x) => x.code),
    ).toEqual(["ZZA", "ZZB"]);
    const run = await main.execute(
      "SELECT details_json FROM run_record WHERE job = 'universe-import' AND status = 'success'",
    );
    expect(JSON.parse(String(run.rows[0].details_json))).toMatchObject({ source: "manual" });
    expect(await uploadUniverseAction(form(csv))).toMatchObject({
      ok: true,
      message: expect.stringContaining("already been applied"),
    });
  });
});
