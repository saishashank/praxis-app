// @vitest-environment node
// The expert page's "Sources and licence" card (M22 E1; KB-083): each source's status in words, and the
// "accept the risk" control only for the Owner and only where it can mean something. Synthetic ZZ data only.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLicence, type LicenceRow } from "@/lib/experts/licence/store";
import { ENV } from "../../auth/helpers";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld, type World } from "../uiWorld";

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("NEXT_FORBIDDEN");
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import ExpertPage from "@/app/(app)/reviews/experts/[id]/page";

afterAll(cleanupTempDbs);
process.env.PII_HASH_KEY = ENV.PII_HASH_KEY;

const text = (html: string) =>
  html
    .replace(/<script.*?<\/script>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

let w: World;
beforeEach(async () => {
  w = await zzWorld();
  mem.main = w.main;
  mem.auth = w.auth;
});
const as = (who: "owner" | "editor" | "viewer") => {
  mem.user = { id: w[who], email: `${who}@example.test`, name: null, role: who };
};
const SRC = "https://zz1.example.test";
const seed = (o: Partial<LicenceRow> = {}) =>
  appendLicence(w.main, {
    expertId: "X-ZZ1",
    sourceKey: SRC,
    checkedAt: "2020-03-01T00:00:00.000Z",
    termsUrl: `${SRC}/terms`,
    robots: "allows",
    summarisation: "no",
    status: "no",
    actor: "job",
    note: null,
    ...o,
  });
const page = async () =>
  renderToStaticMarkup(await ExpertPage({ params: Promise.resolve({ id: "X-ZZ1" }) }));

describe("expert page, sources and licence", () => {
  it("says in words what each source's status is, with no internal code", async () => {
    await seed();
    as("viewer");
    const t = text(await page());
    expect(t).toContain("Sources and licence");
    expect(t).toContain("Not allowed: its terms forbid automated reading or summarising.");
    expect(t).toContain("Not checked yet. Nothing is read from it until it has been checked.");
    expect(t).toContain("Last checked 2020-03-01. A terms page was found.");
    expect(t).not.toMatch(/KB-\d|D-\d{3}|owner-accepted-risk/);
  });

  it("only the Owner gets the control, and only where the terms (not robots) said no", async () => {
    await seed();
    as("owner");
    const owner = await page();
    expect(owner).toContain("Accept the risk");
    expect(owner.match(/Accept the risk for /g)).toHaveLength(1);
    for (const who of ["editor", "viewer"] as const) {
      as(who);
      expect(await page()).not.toContain("Accept the risk");
    }
  });

  it("no control when robots disallows or the source is already allowed", async () => {
    as("owner");
    await seed({ robots: "disallows", summarisation: "unknown" });
    expect(await page()).not.toContain("Accept the risk");
    await seed({
      checkedAt: "2021-04-01T00:00:00.000Z",
      status: "enabled",
      summarisation: "unknown",
    });
    const t = text(await page());
    expect(t).toContain("Allowed for titles and links only");
  });

  it("shows an accepted risk in words", async () => {
    await seed({
      status: "owner-accepted-risk",
      actor: "owner",
      checkedAt: "2021-05-01T00:00:00.000Z",
    });
    as("viewer");
    expect(text(await page())).toContain("Allowed on your accepted risk. Titles and links only.");
  });
});
