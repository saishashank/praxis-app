// @vitest-environment node
// AT-77 (M21 A2, PRD-041, D-931, D-1210, D-1214, D-1215): in a fresh configuration the Owner switch and the other Phase R
// defaults read "off"; the Owner-tool routes answer as a missing route to every role while it is off (and to Editors and
// Viewers while it is on); the proxy reads the switch through the 60 s cache and fails closed; nothing in src/ calls a
// Workers-AI model or reads a sweep (D-1235). The hash half of AT-77 (the switch moves no book) is at77Hash.test.ts.
// Synthetic data only (SEC-110).
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { requireOwnerTools, requireOwnerToolsRoute } from "@/lib/auth/ownerToolsGuard";
import type { CurrentUser } from "@/lib/auth/session";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { CACHE_TTL_MS, getConfigCached, invalidateConfigCache } from "@/lib/config/runtime";
import { getConfig, setConfig } from "@/lib/config/store";
import { ownerToolsSwitchOn } from "@/lib/http/hiddenRoutes";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

const holder = vi.hoisted(() => ({ main: null as unknown }));
vi.mock("@/lib/db/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/client")>()),
  mainDb: () => holder.main,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
afterAll(cleanupTempDbs);

const ENV = { OWNER_EMAIL: "owner@example.test" } as Record<string, string | undefined>;
const u = (role: CurrentUser["role"], email: string): CurrentUser => ({
  id: 1,
  email,
  name: null,
  role,
});
const PINNED = u("owner", "owner@example.test");

describe("AT-77 (a): a fresh configuration", () => {
  let main: Client;
  beforeEach(async () => {
    main = await freshDb("main");
    holder.main = main;
    invalidateConfigCache();
  });

  it("the Phase R defaults are all off, unset in the store and Owner-editable", async () => {
    for (const key of [
      "owner_real_money_tools",
      "stop_hit_email_default",
      "pwa_push_enabled",
    ] as const) {
      expect(CONFIG_KEYS[key].default, key).toBe("off");
      expect(await getConfig(main, key), key).toBe("off");
    }
    expect(CONFIG_KEYS.app_public_domain.default).toBe("");
    expect(await getConfig(main, "app_public_domain")).toBe("");
    expect(CONFIG_KEYS.owner_real_money_tools.editable).toBe("O");
    expect(await ownerToolsSwitchOn()).toBe(false);
  });

  it("the routes answer as a missing route for every role while the switch is off, the Owner included", async () => {
    for (const user of [
      null,
      u("viewer", "v@example.test"),
      u("editor", "e@example.test"),
      u("owner", "second@example.test"),
      PINNED,
    ]) {
      for (const route of ["/recommendations", "/holdings", "/trades", "/api/owner-tools/x"]) {
        const deps = { env: ENV, getUser: async () => user, ownerToolsOn: ownerToolsSwitchOn };
        await expect(requireOwnerTools(route, deps), route).rejects.toThrow("NEXT_NOT_FOUND");
        await expect(requireOwnerToolsRoute(route, deps), route).rejects.toThrow("NEXT_NOT_FOUND");
      }
    }
  });

  it("switched on: the pinned Owner passes, Editors, Viewers and a second owner-role row still get the 404", async () => {
    await setConfig(main, {
      key: "owner_real_money_tools",
      value: "on",
      userId: null,
      reason: "AT-77",
      now: "2030-01-01T00:00:00.000Z",
    });
    invalidateConfigCache();
    expect(await ownerToolsSwitchOn()).toBe(true);
    const deps = (user: CurrentUser | null) => ({
      env: ENV,
      getUser: async () => user,
      ownerToolsOn: ownerToolsSwitchOn,
    });
    expect(await requireOwnerTools("/holdings", deps(PINNED))).toEqual(PINNED);
    for (const user of [
      null,
      u("viewer", "v@example.test"),
      u("editor", "e@example.test"),
      u("owner", "second@example.test"),
    ]) {
      await expect(requireOwnerTools("/holdings", deps(user))).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("the proxy's switch read is cached for 60 s and a failed read means off (D-1215)", async () => {
    let now = 1_000_000;
    let reads = 0;
    const db = () => {
      reads++;
      return main;
    };
    expect(await getConfigCached("owner_real_money_tools", "global", { db, now: () => now })).toBe(
      "off",
    );
    await setConfig(main, {
      key: "owner_real_money_tools",
      value: "on",
      userId: null,
      reason: "AT-77",
      now: "2030-01-01T00:00:00.000Z",
    });
    now += CACHE_TTL_MS - 1;
    expect(await getConfigCached("owner_real_money_tools", "global", { db, now: () => now })).toBe(
      "off",
    );
    expect(reads).toBe(1);
    now += 2;
    expect(await getConfigCached("owner_real_money_tools", "global", { db, now: () => now })).toBe(
      "on",
    );
    // a failing database: the default (off), fail closed
    invalidateConfigCache();
    const broken = () => {
      throw new Error("down");
    };
    expect(
      await getConfigCached("owner_real_money_tools", "global", { db: broken, now: () => now }),
    ).toBe("off");
  });
});

describe("AT-77 (b): no Workers-AI adapter and no sweep reader exist in src (D-1235)", () => {
  const files = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files(full, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  it("no source file calls a Workers-AI model or reads a sweep", () => {
    const offenders = files(path.resolve(import.meta.dirname, "..", "..", "..", "src")).filter(
      (f) => /workers-ai|@cf\/|env\.AI\.run|readSweep|sweepReader/.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
