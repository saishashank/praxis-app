// M7 T11 TST-122 for dismissWelcomeAction: guard first, per-user cookie, no cookie for a refused user.
import { beforeEach, describe, expect, it, vi } from "vitest";

const set = vi.hoisted(() => vi.fn());
const requireUser = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ set }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser }));

import { dismissWelcomeAction } from "@/app/(app)/home/actions";
import { welcomeCookieName } from "@/app/(app)/home/welcome";

beforeEach(() => {
  set.mockReset();
  requireUser.mockReset();
});

describe("dismissWelcomeAction", () => {
  it.each(["owner", "editor", "viewer"])(
    "%s: sets only their own cookie after the guard",
    async (role) => {
      requireUser.mockResolvedValue({ id: 5, role });
      await dismissWelcomeAction();
      expect(requireUser).toHaveBeenCalledWith("read", "/");
      expect(set).toHaveBeenCalledTimes(1);
      const [name, value, opts] = set.mock.calls[0]!;
      expect(name).toBe(welcomeCookieName(5));
      expect(value).toBe("1");
      expect(opts).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax" });
    },
  );

  it("a refused user (guard throws) gets no cookie", async () => {
    requireUser.mockRejectedValue(new Error("forbidden"));
    await expect(dismissWelcomeAction()).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });
});
