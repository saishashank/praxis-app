// @vitest-environment node
// M21 B2 (ARN-121, D-1221, D-1275, AT-77, AT-78; F): the two trade-log server actions (addTradesAction, voidTradeAction).
// Each calls requireOwnerTools first and does nothing when it refuses; the Owner's valid input is appended and audited with
// counts only; bad input is refused with a plain sentence (and a CSV row number) and writes nothing; a void is a new row
// with a reason and is never repeated. Nothing is updated or deleted.
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

import { addTradesAction, voidTradeAction } from "@/app/(app)/(owner-tools)/trades/actions";

afterAll(cleanupTempDbs);

let owner: number;
const REFUSED = new Error("NEXT_HTTP_ERROR_FALLBACK;404");
const form = (entries: Array<[string, string | Blob]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};
const typed = (over: Record<string, string> = {}) =>
  form(
    Object.entries({
      mode: "typed",
      market: "AU",
      code: "zzup",
      side: "buy",
      date: "2026-10-21",
      qty: "100",
      price: "10.10",
      fees: "5",
      note: "first lot",
      ...over,
    }),
  );
const n = async (t: string) =>
  Number((await h.main.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
const HEAD = "market,code,side,date,quantity,price,fees,note";

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
  it("addTradesAction", async () => {
    await expect(addTradesAction(typed())).rejects.toBe(REFUSED);
    expect(await n("owner_trade")).toBe(0);
    expect(h.guard).toHaveBeenCalledWith("/trades");
  });
  it("voidTradeAction", async () => {
    await expect(
      voidTradeAction(
        form([
          ["trade_id", "1"],
          ["reason", "typo"],
        ]),
      ),
    ).rejects.toBe(REFUSED);
    expect(await n("owner_trade_void")).toBe(0);
  });
});

describe("addTradesAction", () => {
  it("appends one typed trade and audits the count and the way it came in, not its content", async () => {
    expect(await addTradesAction(typed())).toEqual({ ok: true });
    const r = (
      await h.main.execute(
        "SELECT code, side, qty, price_micro, source, upload_id, entered_by FROM owner_trade",
      )
    ).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      code: "ZZUP",
      side: "buy",
      qty: 100,
      source: "typed",
      upload_id: null,
      entered_by: `user:${owner}`,
    });
    expect(BigInt(String(r[0]!.price_micro))).toBe(10_100_000n);
    const a = (await auditRows(h.auth)).filter((x) => x.action === "owner.trades_add");
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).not.toMatch(/ZZUP|10\.10|first lot/);
    expect(h.revalidated).toContain("/trades");
  });

  it("a blank market means the page's market", async () => {
    expect(await addTradesAction(typed({ market: "" }))).toEqual({ ok: true });
    expect(await n("owner_trade")).toBe(1);
  });

  it("imports a CSV as one upload; a bad row refuses the whole file and names its line", async () => {
    const ok = await addTradesAction(
      form([
        ["mode", "csv"],
        [
          "csv_text",
          `${HEAD}\nAU,ZZUP,buy,2026-10-21,100,10.10,5,\nAU,ZZUP,sell,2026-10-26,100,10.40,5,`,
        ],
      ]),
    );
    expect(ok).toEqual({ ok: true });
    expect(await n("owner_trade")).toBe(2);
    const up = (await h.main.execute("SELECT DISTINCT upload_id, source FROM owner_trade")).rows;
    expect(up).toHaveLength(1);
    expect(up[0]!.source).toBe("csv");
    const bad = await addTradesAction(
      form([
        ["mode", "csv"],
        [
          "csv_text",
          `${HEAD}\nAU,ZZUP,buy,2026-10-21,100,10.10,5,\nAU,ZZUP,buy,2026-10-22,x,10.10,5,`,
        ],
      ]),
    );
    expect(bad).toMatchObject({ error: "bad_row", message: expect.stringContaining("(row 3)") });
    expect(await n("owner_trade")).toBe(2);
  });

  it("refuses a bad typed trade, a market that is not enabled and a future date, writing nothing", async () => {
    expect(await addTradesAction(typed({ qty: "0" }))).toMatchObject({ error: "bad_row" });
    expect(await addTradesAction(typed({ market: "IN" }))).toMatchObject({ error: "bad_row" });
    expect(await addTradesAction(typed({ date: "2999-01-01" }))).toMatchObject({
      error: "bad_row",
    });
    expect(await n("owner_trade")).toBe(0);
    expect((await auditRows(h.auth)).filter((x) => x.action === "owner.trades_add")).toHaveLength(
      0,
    );
  });
});

describe("voidTradeAction", () => {
  it("appends a void with the reason, audits it and refuses a second one", async () => {
    await addTradesAction(typed());
    const first = await voidTradeAction(
      form([
        ["trade_id", "1"],
        ["reason", "wrong price"],
      ]),
    );
    expect(first).toEqual({ ok: true });
    expect(await n("owner_trade")).toBe(1);
    const v = (await h.main.execute("SELECT trade_id, reason FROM owner_trade_void")).rows;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ trade_id: 1, reason: "wrong price" });
    expect((await auditRows(h.auth)).filter((x) => x.action === "owner.trade_void")).toHaveLength(
      1,
    );
    const again = await voidTradeAction(
      form([
        ["trade_id", "1"],
        ["reason", "again"],
      ]),
    );
    expect(again).toMatchObject({ error: "already" });
    expect(await n("owner_trade_void")).toBe(1);
  });

  it("needs a reason and a real trade", async () => {
    await addTradesAction(typed());
    const call = (id: string, reason: string) =>
      voidTradeAction(
        form([
          ["trade_id", id],
          ["reason", reason],
        ]),
      );
    expect(await call("1", " ")).toMatchObject({ error: "bad_row" });
    expect(await call("abc", "x")).toMatchObject({ error: "bad_row" });
    expect(await call("42", "x")).toMatchObject({ error: "not_found" });
    expect(await n("owner_trade_void")).toBe(0);
  });
});
