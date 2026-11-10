// D-911 History tab of /picks rendered from a real (temporary) database: every status (open, closed,
// not traded, waiting), the change and days held, the plan line, the empty text of a filter, the
// Older / Newest page links and a masked viewer (letters and percentages, no prices, no paging).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { D, envOf, fullWorld, SHA, type Who, type World } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import PicksPage from "@/app/(app)/picks/page";

let current: LoaderEnv;
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => ({ id: 1, role: "owner" })) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => current,
}));

afterAll(cleanupTempDbs);
afterEach(cleanup);

const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const as = (w: World, who: Who) => {
  current = envOf(w, who);
};

let w: World;

async function pick(d: string, rank: number, code: string) {
  await w.main.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
            typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
            pick_sha, created_at)
          VALUES ('AU', ?, 'balanced', ?, ?, 'F1', 'U1', 'F1.v1', 's1', 'UNVALIDATED', 10000000, 10050000,
            '2026-10-23', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000,
            '[]', '[]', ?, ?)`,
    args: [d, rank, code, SHA, `${d}T07:00:00.000Z`],
  });
}
async function outcome(d: string, rank: number, code: string, set?: string, args: unknown[] = []) {
  await w.main.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('AU', ?, 'balanced', ?, 'pick', ?, ?, 'waiting', ?)`,
    args: [d, rank, code, SHA, D],
  });
  if (set)
    await w.main.execute({
      sql: `UPDATE pick_outcome SET ${set}, updated_d = ?
            WHERE market = 'AU' AND d = ? AND profile = 'balanced' AND rank = ? AND kind = 'pick'`,
      args: [...(args as string[]), D, d, rank],
    });
}

beforeAll(async () => {
  w = await fullWorld(); // rank 1 ZZUP closed at the aim on D; rank 2 ZZOTH published
  await outcome(D, 2, "ZZOTH", "state = 'bought', entry_d = '2026-10-16', entry_micro = 2000000");
  await pick(D, 3, "ZZDN");
  await outcome(D, 3, "ZZDN", "state = 'missed'");
  await pick(D, 4, "ZZDN");
  await outcome(D, 4, "ZZDN");
  // 24 older waiting picks, so "All" has more than one page of 25
  for (const d of ["2026-10-13", "2026-10-14", "2026-10-15"])
    for (let rank = 1; rank <= 8; rank += 1) {
      await pick(d, rank, "ZZUP");
      await outcome(d, rank, "ZZUP");
    }
});

const table = () => screen.getByRole("table", { name: "History of published picks" });

describe("History tab (D-911)", () => {
  it("All: every status with its plan, prices, days held and change; Older leads to page 2", async () => {
    as(w, "owner");
    render(await PicksPage({ searchParams: sp({ view: "history", status: "all" }) }));
    const t = table();
    const body = within(t).getAllByRole("row").slice(1);
    expect(body).toHaveLength(25);
    expect(body[0]).toHaveTextContent("Zed Upward Holdings (ZZUP)");
    expect(body[0]).toHaveTextContent(/Closed\s*aim reached/);
    expect(body[0]).toHaveTextContent("after costs");
    expect(body[0]).toHaveTextContent("Plan: buy up to");
    expect(body[1]).toHaveTextContent("Open");
    expect(body[1]).toHaveTextContent("now");
    expect(body[1]).toHaveTextContent("+10.0%");
    expect(body[2]).toHaveTextContent("Not traded (buy price not reached)");
    expect(body[3]).toHaveTextContent("Waiting to buy");
    const older = screen.getByRole("link", { name: "Older" });
    expect(older.getAttribute("href")).toMatch(
      /^\/picks\?profile=balanced&view=history&status=all&after=/,
    );
    expect(screen.queryByRole("link", { name: "Newest" })).toBeNull();
  });

  it("page 2 shows the rest and a link back to the newest", async () => {
    as(w, "owner");
    render(
      await PicksPage({
        searchParams: sp({ view: "history", status: "all", after: "2026-10-13.4" }),
      }),
    );
    expect(within(table()).getAllByRole("row").slice(1)).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Newest" })).toHaveAttribute(
      "href",
      "/picks?profile=balanced&view=history&status=all",
    );
    expect(screen.queryByRole("link", { name: "Older" })).toBeNull();
  });

  it("a filter with no rows says so", async () => {
    as(w, "owner");
    render(await PicksPage({ searchParams: sp({ view: "history", status: "loss" }) }));
    expect(screen.getByText("No pick is in loss.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a masked viewer sees letters and percentages, no prices, no plan and no page links", async () => {
    as(w, "viewer");
    const { container } = render(
      await PicksPage({ searchParams: sp({ view: "history", status: "all" }) }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/ZZUP|ZZOTH|ZZDN|Zed /);
    expect(text).not.toMatch(/A\$|\$\d/);
    expect(text).not.toContain("Plan:");
    expect(text).toContain("+5.0%");
    expect(screen.queryByRole("link", { name: "Older" })).toBeNull();
  });
});
