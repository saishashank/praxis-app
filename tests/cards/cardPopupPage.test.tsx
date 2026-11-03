// D-884: the Decision Card popup route renders the same card body as the page, inside the dialog,
// behind the same guard; the empty slot pages render nothing.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { CARD_UP, emptyDbs, seedPopulated, type Both } from "../loaders/seed";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ back: vi.fn() }),
  usePathname: () => "/cards/x",
}));

import CardPopup from "@/app/(app)/@modal/(.)cards/[id]/page";
import NoModal from "@/app/(app)/@modal/default";

let db: Both;
beforeAll(async () => {
  db = await emptyDbs();
  await seedPopulated(db);
  mem.main = db.main;
  mem.auth = db.auth;
});
afterAll(cleanupTempDbs);

describe("Decision Card popup route (D-884)", () => {
  it("guards first, then shows the card inside the dialog", async () => {
    requireUser.mockResolvedValue({ id: 1, email: "o@example.test", name: null, role: "owner" });
    const html = renderToStaticMarkup(
      await CardPopup({ params: Promise.resolve({ id: encodeURIComponent(CARD_UP) }) }),
    );
    expect(requireUser).toHaveBeenCalledWith("read", `/cards/${encodeURIComponent(CARD_UP)}`);
    expect(html).toMatch(/^<dialog[^>]*aria-label="Decision Card"/);
    expect(html).toContain("What and why");
    expect(html).toContain(">Close<");
  });

  it("an undecodable address is not found, like the page", async () => {
    requireUser.mockResolvedValue({ id: 1, email: "o@example.test", name: null, role: "owner" });
    await expect(CardPopup({ params: Promise.resolve({ id: "%E0%A4%A" }) })).rejects.toThrow();
  });

  it("the empty slot renders nothing", () => {
    expect(NoModal()).toBeNull();
  });
});
