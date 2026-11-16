// @vitest-environment node
// M21 B1 (D-1247, AT-77, AT-78; F): the three Owner-tool server actions (saveCapitalAction, saveBrokerLinksAction,
// saveHoldingsAction). Each calls requireOwnerTools first and does nothing when it refuses; the Owner's valid input is
// stored (capital and templates through the audited preferences service, holdings as one new upload); bad input is refused
// with a plain sentence and writes nothing; no action answers with the amount or the address.
import type { Client } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser, auditRows, ENV } from "../auth/helpers";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  main: null as unknown as Client,
  auth: null as unknown as Client,
  revalidated: [] as string[],
}));
vi.mock("@/lib/auth/ownerToolsGuard", () => ({ requireOwnerTools: h.guard }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => h.main, authDb: () => h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/ui/loaders/shell", () => ({ envFor: async () => ({ market: "AU" }) }));

import {
  saveBrokerLinksAction,
  saveCapitalAction,
} from "@/app/(app)/(owner-tools)/recommendations/actions";
import { saveHoldingsAction } from "@/app/(app)/(owner-tools)/holdings/actions";
import { getPreferences } from "@/lib/preferences/service";

afterAll(cleanupTempDbs);

let owner: number;
const REFUSED = new Error("NEXT_HTTP_ERROR_FALLBACK;404");

const form = (entries: Array<[string, string | Blob]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};
const holdingRows = async () =>
  Number((await h.main.execute("SELECT COUNT(*) AS n FROM owner_holding")).rows[0]!.n);

beforeEach(async () => {
  Object.assign(process.env, ENV);
  h.main = await freshDb("main");
  h.auth = await freshDb("auth");
  owner = await addUser(h.auth, { email: ENV.OWNER_EMAIL!, role: "owner" });
  h.revalidated.length = 0;
  h.guard.mockReset();
  h.guard.mockResolvedValue({ id: owner, email: ENV.OWNER_EMAIL, name: null, role: "owner" });
});

describe("every action asks requireOwnerTools first and does nothing when it refuses", () => {
  beforeEach(() => {
    h.guard.mockImplementation(async () => {
      throw REFUSED;
    });
  });

  it("saveCapitalAction", async () => {
    await expect(saveCapitalAction(form([["real_capital", "5000"]]))).rejects.toBe(REFUSED);
    expect((await getPreferences(h.auth, owner)).real_capital).toBe(0);
    expect(h.guard).toHaveBeenCalledWith("/recommendations");
  });

  it("saveBrokerLinksAction", async () => {
    await expect(
      saveBrokerLinksAction(
        form([
          ["broker_name", "Mine"],
          ["broker_template", "https://broker.example/t?c={code}"],
        ]),
      ),
    ).rejects.toBe(REFUSED);
    expect((await getPreferences(h.auth, owner)).broker_links).toEqual([]);
  });

  it("saveHoldingsAction", async () => {
    await expect(
      saveHoldingsAction(
        form([
          ["mode", "csv"],
          ["csv_text", "code,quantity,average_cost\nZZA,1,1"],
        ]),
      ),
    ).rejects.toBe(REFUSED);
    expect(await holdingRows()).toBe(0);
    expect(h.guard).toHaveBeenCalledWith("/holdings");
  });
});

describe("saveCapitalAction", () => {
  it("stores a whole amount (commas and spaces ignored) and audits the field, never the amount", async () => {
    expect(await saveCapitalAction(form([["real_capital", " 12,500 "]]))).toEqual({ ok: true });
    expect((await getPreferences(h.auth, owner)).real_capital).toBe(12_500);
    const audit = (await auditRows(h.auth)).filter((a) => a.action === "user.preferences_update");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("12500");
    expect(h.revalidated).toContain("/recommendations");
  });

  it("0 clears the amount", async () => {
    await saveCapitalAction(form([["real_capital", "12500"]]));
    expect(await saveCapitalAction(form([["real_capital", "0"]]))).toEqual({ ok: true });
    expect((await getPreferences(h.auth, owner)).real_capital).toBe(0);
  });

  it("refuses a fraction, a negative, text, a number out of range and a missing field", async () => {
    for (const v of ["1.5", "-1", "abc", "10000001", "", "1e3"]) {
      const r = await saveCapitalAction(form([["real_capital", v]]));
      expect(r, v).toMatchObject({ error: "invalid" });
    }
    expect(await saveCapitalAction(form([]))).toMatchObject({ error: "invalid" });
    expect((await getPreferences(h.auth, owner)).real_capital).toBe(0);
  });

  it("a stored role that is not owner is refused by the service even if a guard were to pass", async () => {
    const editor = await addUser(h.auth, { email: "e@example.test", role: "editor" });
    h.guard.mockResolvedValue({ id: editor, email: "e@example.test", name: null, role: "editor" });
    expect(await saveCapitalAction(form([["real_capital", "100"]]))).toMatchObject({
      error: "forbidden",
    });
    expect((await getPreferences(h.auth, editor)).real_capital).toBe(0);
  });
});

describe("saveBrokerLinksAction", () => {
  const ok = (n: string, t: string): Array<[string, string]> => [
    ["broker_name", n],
    ["broker_template", t],
  ];

  it("stores valid templates, skipping empty rows", async () => {
    const r = await saveBrokerLinksAction(
      form([
        ...ok("One", "https://one.example/t?c={code}"),
        ...ok("", ""),
        ...ok("Two", "https://two.example/{market}/{code}"),
      ]),
    );
    expect(r).toEqual({ ok: true });
    expect((await getPreferences(h.auth, owner)).broker_links).toEqual([
      { name: "One", url_template: "https://one.example/t?c={code}" },
      { name: "Two", url_template: "https://two.example/{market}/{code}" },
    ]);
  });

  it("an empty form clears the list", async () => {
    await saveBrokerLinksAction(form(ok("One", "https://one.example/t?c={code}")));
    expect(await saveBrokerLinksAction(form(ok("", "")))).toEqual({ ok: true });
    expect((await getPreferences(h.auth, owner)).broker_links).toEqual([]);
  });

  it("refuses the whole form with the row and the reason when one template is bad", async () => {
    for (const [t, why] of [
      ["http://one.example/t?c={code}", "https://"],
      ["https://u:p@one.example/t?c={code}", "user name"],
      ["https://one.example/t?c={code}&api_key=1", "credential"],
      ["https://one.example/t", "{code}"],
      ["https://one.example/{price}/{code}", "placeholders"],
    ] as const) {
      const r = await saveBrokerLinksAction(
        form([...ok("Good", "https://good.example/t?c={code}"), ...ok("Bad", t)]),
      );
      expect(r, t).toMatchObject({ error: "invalid" });
      expect((r as { message: string }).message).toMatch(/^Row 2: /);
      expect((r as { message: string }).message).toContain(why);
    }
    expect((await getPreferences(h.auth, owner)).broker_links).toEqual([]);
  });

  it("refuses a name without an address and an address without a name", async () => {
    expect(await saveBrokerLinksAction(form(ok("Only a name", "")))).toMatchObject({
      error: "invalid",
    });
    expect(await saveBrokerLinksAction(form(ok("", "https://x.example/{code}")))).toMatchObject({
      error: "invalid",
    });
  });

  it("refuses more than five", async () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      ok(`B${i}`, `https://b${i}.example/{code}`),
    ).flat();
    expect(await saveBrokerLinksAction(form(six))).toMatchObject({ error: "invalid" });
  });
});

describe("saveHoldingsAction", () => {
  it("saves the typed table as one new upload", async () => {
    const r = await saveHoldingsAction(
      form([
        ["mode", "manual"],
        ["code", "zza"],
        ["qty", "10"],
        ["cost", "2.5"],
        ["code", ""],
        ["qty", ""],
        ["cost", ""],
      ]),
    );
    expect(r).toEqual({ ok: true });
    const rows = (
      await h.main.execute("SELECT code, qty, avg_cost_micro, market FROM owner_holding")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "ZZA", market: "AU" });
    expect(Number(rows[0]!.qty)).toBe(10);
    expect(Number(rows[0]!.avg_cost_micro)).toBe(2_500_000);
    expect(h.revalidated).toContain("/holdings");
  });

  it("imports a pasted CSV and an uploaded CSV file", async () => {
    const text = "code,quantity,average_cost\nZZA,1,1\nZZB,2,2";
    expect(
      await saveHoldingsAction(
        form([
          ["mode", "csv"],
          ["csv_text", text],
        ]),
      ),
    ).toEqual({ ok: true });
    expect(await holdingRows()).toBe(2);
    const file = new File([text + "\nZZC,3,3"], "h.csv", { type: "text/csv" });
    expect(
      await saveHoldingsAction(
        form([
          ["mode", "csv"],
          ["csv_file", file],
        ]),
      ),
    ).toEqual({ ok: true });
    expect(await holdingRows()).toBe(5); // append-only: both uploads kept
  });

  it("refuses a bad CSV with its row number, and writes nothing", async () => {
    const r = await saveHoldingsAction(
      form([
        ["mode", "csv"],
        ["csv_text", "code,quantity,average_cost\nZZA,1,1\nZZB,x,2"],
      ]),
    );
    expect(r).toMatchObject({ error: "bad_row" });
    expect((r as { message: string }).message).toContain("row 3");
    expect(await holdingRows()).toBe(0);
  });

  it("refuses an over-large file without reading it, and an empty save", async () => {
    const big = new File(["x".repeat(65_536 * 4 + 1)], "big.csv", { type: "text/csv" });
    expect(
      await saveHoldingsAction(
        form([
          ["mode", "csv"],
          ["csv_file", big],
        ]),
      ),
    ).toMatchObject({
      error: "too_large",
    });
    expect(await saveHoldingsAction(form([["mode", "manual"]]))).toMatchObject({ error: "empty" });
    expect(await holdingRows()).toBe(0);
  });
});
