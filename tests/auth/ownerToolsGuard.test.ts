// @vitest-environment node
// M21 A2 (D-1214, UX-131, AT-77): the Owner-tools guard answers as a missing route for everyone but the pinned Owner
// with the switch on, for pages and for route handlers, and fails closed.
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/session";
import {
  requireOwnerTools,
  requireOwnerToolsRoute,
  type OwnerToolsDeps,
} from "@/lib/auth/ownerToolsGuard";
import { ENV } from "./helpers";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => undefined, mainDb: () => undefined }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

const u = (role: CurrentUser["role"], email: string): CurrentUser => ({
  id: 1,
  email,
  name: null,
  role,
});
const PINNED = u("owner", ENV.OWNER_EMAIL!);
const USERS: [string, CurrentUser | null][] = [
  ["anonymous", null],
  ["viewer", u("viewer", "v@example.test")],
  ["editor", u("editor", "e@example.test")],
  ["owner role, another address (a second owner-role row)", u("owner", "other@example.test")],
  ["the pinned Owner", PINNED],
];
const mk = (user: CurrentUser | null, on: boolean | "throw"): OwnerToolsDeps => ({
  env: ENV,
  getUser: async () => user,
  ownerToolsOn: async () => {
    if (on === "throw") throw new Error("config down");
    return on;
  },
});
const digest = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e);
  }
};

describe("requireOwnerTools / requireOwnerToolsRoute", () => {
  for (const [name, user] of USERS) {
    for (const on of [false, true] as const) {
      const pass = user === PINNED && on;
      it(`${name}, switch ${on ? "on" : "off"}: ${pass ? "passes" : "not found"}`, async () => {
        for (const fn of [requireOwnerTools, requireOwnerToolsRoute]) {
          const d = await digest(fn("/holdings", mk(user, on)));
          if (pass) expect(d).toBeNull();
          else expect(d).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
        }
      });
    }
  }

  it("the pinned Owner gets the user back", async () => {
    expect(await requireOwnerTools("/trades", mk(PINNED, true))).toEqual(PINNED);
    expect(await requireOwnerToolsRoute("/api/owner-tools/x", mk(PINNED, true))).toEqual(PINNED);
  });

  it("a config read failure, a user lookup failure: the same not-found, never a 403 or a 500", async () => {
    const bad: OwnerToolsDeps = {
      env: ENV,
      getUser: async () => {
        throw new Error("auth down");
      },
      ownerToolsOn: async () => true,
    };
    const expected = await digest(requireOwnerTools("/holdings", mk(null, true)));
    expect(await digest(requireOwnerTools("/holdings", mk(PINNED, "throw")))).toBe(expected);
    expect(await digest(requireOwnerTools("/holdings", bad))).toBe(expected);
  });

  it("every refusal is byte-identical (no role-dependent signal)", async () => {
    const all = await Promise.all(
      USERS.filter(([, x]) => x !== PINNED).map(([, x]) =>
        digest(requireOwnerTools("/holdings", mk(x, true))),
      ),
    );
    expect(new Set(all).size).toBe(1);
  });
});

describe("ownerToolsVisibleTo", () => {
  it("is true only for the pinned Owner with the switch on, and never throws", async () => {
    const { ownerToolsVisibleTo } = await import("@/lib/auth/ownerToolsGuard");
    for (const [name, user] of USERS) {
      for (const on of [false, true, "throw"] as const) {
        const expected = user === PINNED && on === true;
        expect(await ownerToolsVisibleTo(user, mk(user, on)), `${name} switch ${String(on)}`).toBe(
          expected,
        );
      }
    }
  });

  it("a null user is false without reading the switch", async () => {
    const { ownerToolsVisibleTo } = await import("@/lib/auth/ownerToolsGuard");
    const ownerToolsOn = vi.fn(async () => true);
    expect(await ownerToolsVisibleTo(null, { ...mk(null, true), ownerToolsOn })).toBe(false);
    expect(ownerToolsOn).not.toHaveBeenCalled();
  });
});
