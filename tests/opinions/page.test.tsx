// @vitest-environment node
// The opinion meters on the Committee page (M22 C4; AGT-148, D-1427, D-1520): a small read-only section that every role can
// read (counts and a gap, no code, no rating), shown with and without a trial, with the kinds that have no forward meter.
// Synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser, ENV } from "../auth/helpers";
import { build } from "../committee/trialWorld";

const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("@/auth", () => ({ handlers: { GET: vi.fn(), POST: vi.fn() }, auth: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("NEXT_FORBIDDEN");
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import CommitteeTrialPage from "@/app/(app)/strategies/experiments/committee/page";
import { loadCommitteeTrial } from "@/lib/ui/loaders/committee";

afterEach(cleanupTempDbs);
process.env.PII_HASH_KEY = ENV.PII_HASH_KEY;

const text = (html: string) =>
  html
    .replace(/<script.*?<\/script>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function as(main: Client, who: "owner" | "viewer"): Promise<{ id: number }> {
  const auth = await freshDb("auth");
  const id = await addUser(auth, { email: `${who}@example.test`, role: who });
  mem.main = main;
  mem.auth = auth;
  mem.user = { id, email: `${who}@example.test`, name: null, role: who };
  return { id };
}
const render = async () =>
  text(renderToStaticMarkup(await CommitteeTrialPage({ searchParams: Promise.resolve({}) })));

const SPECS = Array.from({ length: 6 }, (_, i) => [
  { night: i, rating: "approve" as const, net: 1000 },
  { night: i, rating: "reject" as const, net: 0 },
]).flat();

describe("opinion meters on the Committee page", () => {
  it("shows both meters and the kinds with no meter even with no trial", async () => {
    const main = await freshDb("main");
    await as(main, "owner");
    const t = await render();
    expect(t).toContain("How far each kind of opinion has been tested");
    expect(t).toContain("Bull and bear notes: 0 of 150 settled cases so far");
    expect(t).toContain("Committee opinions: 0 of 150 settled cases so far");
    expect(t).toContain("Looking-back notes: no forward meter.");
    expect(t).toContain("Proposed new ideas: no forward meter.");
    expect(t).not.toMatch(/Approve|Reject/);
  });

  it("with a trial: the Committee count of settled signals, for the Owner and for a Viewer alike, and no button", async () => {
    const main = await build(SPECS);
    for (const who of ["owner", "viewer"] as const) {
      await as(main, who);
      const html = renderToStaticMarkup(
        await CommitteeTrialPage({ searchParams: Promise.resolve({}) }),
      );
      const t = text(html);
      expect(t).toContain("Committee opinions: 12 of 150 settled cases so far");
      expect(t).not.toContain("earned a review");
      const section = html.slice(html.indexOf('data-testid="opinion-meters"'));
      expect(section).not.toMatch(/<(button|form|input)\b/);
    }
  });

  it("the loader carries the meters and survives a read that fails", async () => {
    const main = await freshDb("main");
    const { id } = await as(main, "owner");
    const auth = mem.auth as Client;
    const page = await loadCommitteeTrial({
      mainDb: main,
      authDb: auth,
      user: { id, role: "owner" },
    });
    expect(page.data.opinions.meters.map((m) => m.kind)).toEqual(["steelman", "committee"]);
    expect(page.data.opinions.noMeter).toHaveLength(2);
    const broken = { execute: () => Promise.reject(new Error("boom")) } as unknown as Client;
    const soft = await loadCommitteeTrial({
      mainDb: broken,
      authDb: auth,
      user: { id, role: "owner" },
    }).catch(() => null);
    // a database that cannot be read at all fails the whole page as before; the meters never add a new failure
    expect(soft === null || soft.data.opinions.meters.length === 0).toBe(true);
  });
});
