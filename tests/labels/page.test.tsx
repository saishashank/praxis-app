// M21 L1 (UXN-318, D-1227, AT-82): the /cortex/labels page and its form action, on a real temporary database. The guard is
// mocked: an Editor is refused with the 403 (forbidden) and nothing is read; the Owner sees one headline, the count and the
// form; the loader never touches a model-label table; the action audits each write and refuses what is not an answer.
import { cleanup, render, screen } from "@testing-library/react";
import type { Client } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser, auditRows, ENV } from "../auth/helpers";
import { loadLabelsPage } from "@/lib/ui/loaders/labels";

const h = vi.hoisted(() => ({
  role: "owner" as "owner" | "editor",
  guardCalls: [] as string[][],
  main: null as unknown as Client,
  auth: null as unknown as Client,
  revalidated: [] as string[],
  uid: 0,
  statements: [] as string[],
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async (action: string, path: string) => {
    h.guardCalls.push([action, path]);
    if (h.role !== "owner") throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return { id: h.uid, email: "owner@example.test", name: null, role: "owner" };
  },
}));
vi.mock("@/lib/db/client", () => ({
  mainDb: () => ({
    execute: (q: string | { sql: string }) => {
      h.statements.push(typeof q === "string" ? q : q.sql);
      return h.main.execute(q as never);
    },
  }),
  authDb: () => h.auth,
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import LabelsPage from "@/app/(app)/cortex/labels/page";
import { saveGoldenAction } from "@/app/(app)/cortex/labels/actions";

afterAll(cleanupTempDbs);
afterEach(cleanup);

const ann = (annId: string, at: string, title: string) =>
  h.main.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
          VALUES ('AU', 'ZZA', ?, ?, ?, 'results', 1, ?, 'https://example.test/a', 'asx')`,
    args: [annId, at, at, title],
  });
const form = (entries: Array<[string, string]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};
const item = (annId: string): Array<[string, string]> => [
  ["market", "AU"],
  ["source", "asx"],
  ["ann_id", annId],
];
const goldenRows = async () => (await h.main.execute("SELECT * FROM golden_label")).rows;
const all3: Array<[string, string]> = [
  ["guidance", "up"],
  ["event_confirm", "confirmed"],
  ["tone", "positive"],
];

beforeEach(async () => {
  Object.assign(process.env, ENV);
  h.main = await freshDb("main");
  h.auth = await freshDb("auth");
  h.uid = await addUser(h.auth, { email: ENV.OWNER_EMAIL!, role: "owner" });
  h.role = "owner";
  h.guardCalls.length = 0;
  h.statements.length = 0;
  h.revalidated.length = 0;
  await ann("a1", "2030-01-02T00:00:00Z", "ZZ Alpha lifts guidance after a strong half");
  await ann("a2", "2030-01-01T00:00:00Z", "ZZ Beta completes a buy-back");
});

describe("the page", () => {
  it("an Editor is refused with the 403 before anything is read", async () => {
    h.role = "editor";
    await expect(LabelsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/403/);
    expect(h.guardCalls).toEqual([["admin", "/cortex/labels"]]);
    expect(h.statements).toEqual([]);
  });

  it("the Owner sees the newest headline, the count, the three groups and the buttons", async () => {
    render(await LabelsPage({ searchParams: Promise.resolve({}) }));
    expect(h.guardCalls[0]).toEqual(["admin", "/cortex/labels"]);
    expect(screen.getByRole("heading", { name: "Label announcements" })).toBeInTheDocument();
    expect(screen.getByTestId("label-progress").textContent).toContain("0 of 500");
    expect(screen.getByTestId("label-headline").textContent).toContain("Alpha lifts guidance");
    expect(screen.getAllByRole("radio")).toHaveLength(4 + 3 + 3);
    expect(screen.getAllByRole("group")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /^Skip/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Flag as unclear/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the source" })).toHaveAttribute(
      "href",
      "https://example.test/a",
    );
  });

  it("reads no model-label table, and shows no internal code", async () => {
    const { container } = render(await LabelsPage({ searchParams: Promise.resolve({}) }));
    expect(h.statements.length).toBeGreaterThan(0);
    for (const s of h.statements) expect(s).not.toMatch(/text_label|label_item|label_validation/);
    expect(container.textContent).not.toMatch(/\b(D-\d{3,4}|AT-\d+|UXN-\d+|CTX-\d+|DAT-\d+)\b/);
  });

  it("an unknown market in the address falls back to the home market", async () => {
    const r = await loadLabelsPage(h.main, "ZZ", "AU");
    expect(r.market).toBe("AU");
    expect(r.item?.annId).toBe("a1");
  });

  it("an empty queue says so", async () => {
    await saveGoldenAction(form([...item("a1"), ["answer", "skip"]]));
    await saveGoldenAction(form([...item("a2"), ["answer", "skip"]]));
    render(await LabelsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Nothing left to label")).toBeInTheDocument();
    expect(screen.queryByTestId("label-form")).toBeNull();
  });
});

describe("saveGoldenAction", () => {
  it("asks requireUser('admin') first and does nothing when it refuses", async () => {
    h.role = "editor";
    await expect(saveGoldenAction(form([...item("a1"), ["answer", "skip"]]))).rejects.toThrow(
      /403/,
    );
    expect(h.guardCalls[0]).toEqual(["admin", "/cortex/labels"]);
    expect(await goldenRows()).toHaveLength(0);
  });

  it("saves a labelled answer, audits it without the label values, and revalidates", async () => {
    const r = await saveGoldenAction(
      form([...item("a1"), ["answer", "labelled"], ...all3, ["span", "lifts guidance"]]),
    );
    expect(r).toEqual({ ok: true });
    const rows = await goldenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      answer: "labelled",
      guidance: "up",
      span: "lifts guidance",
      actor: `user:${h.uid}`,
    });
    const a = (await auditRows(h.auth)).filter((x) => x.action === "owner.golden_label");
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).not.toMatch(/lifts guidance|positive/);
    expect(h.revalidated).toEqual(["/cortex/labels"]);
  });

  it("a skip and an unclear flag are stored without a label even if one was ticked", async () => {
    await saveGoldenAction(form([...item("a1"), ["answer", "skip"], ["guidance", "up"]]));
    await saveGoldenAction(form([...item("a2"), ["answer", "unclear"]]));
    const rows = await goldenRows();
    expect(rows.map((x) => [x.answer, x.guidance])).toEqual([
      ["skip", null],
      ["unclear", null],
    ]);
  });

  it("refuses an incomplete answer, a bad answer, a bad span, an unknown item and an off market", async () => {
    expect(
      await saveGoldenAction(form([...item("a1"), ["answer", "labelled"], ["guidance", "up"]])),
    ).toMatchObject({ error: "incomplete" });
    expect(await saveGoldenAction(form([...item("a1"), ["answer", "maybe"]]))).toMatchObject({
      error: "bad_answer",
    });
    expect(
      await saveGoldenAction(
        form([...item("a1"), ["answer", "labelled"], ...all3, ["span", "not in it"]]),
      ),
    ).toMatchObject({ error: "bad_span" });
    expect(await saveGoldenAction(form([...item("nope"), ["answer", "skip"]]))).toMatchObject({
      error: "unavailable",
    });
    expect(
      await saveGoldenAction(
        form([
          ["market", "IN"],
          ["source", "asx"],
          ["ann_id", "a1"],
          ["answer", "skip"],
        ]),
      ),
    ).toMatchObject({ error: "unavailable" });
    expect(await goldenRows()).toHaveLength(0);
  });

  it("the next headline follows an answer, and the count rises only for labelled answers", async () => {
    await saveGoldenAction(form([...item("a1"), ["answer", "skip"]]));
    let r = await loadLabelsPage(h.main, null, "AU");
    expect(r.item?.annId).toBe("a2");
    expect(r.count).toBe(0);
    await saveGoldenAction(
      form([
        ...item("a2"),
        ["answer", "labelled"],
        ["guidance", "none"],
        ["event_confirm", "unclear"],
        ["tone", "neutral"],
      ]),
    );
    r = await loadLabelsPage(h.main, null, "AU");
    expect(r.item).toBeNull();
    expect(r.count).toBe(1);
  });
});
