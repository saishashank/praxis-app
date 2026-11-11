// UXN-312, MKT-110 (c), D-997: the header switcher lists the enabled markets only, a built market that is off is
// never named, and a `?market=` candidate that is not enabled is a 404 at the one resolver (envFor).
import type { Client } from "@libsql/client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser } from "../../auth/helpers";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

const holder = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => holder.main, authDb: () => holder.auth }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { RegionMenu } from "@/components/shell/RegionMenu";
import { envFor, loadShell } from "@/lib/ui/loaders/shell";

let main: Client;
let auth: Client;
beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  holder.main = main;
  holder.auth = auth;
});
afterEach(() => {
  cleanup();
  cleanupTempDbs();
});

const opened = (shell: Awaited<ReturnType<typeof loadShell>>): string => {
  const { container } = render(
    createElement(RegionMenu, { market: shell.market, markets: shell.markets }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Region:/ }));
  return container.innerHTML;
};

const owner = { id: 1, role: "owner" };

describe("the enabled-only switcher (D-997)", () => {
  it("lists AU alone when only AU is enabled, never IN or US", async () => {
    const shell = await loadShell(await envFor(owner));
    expect(shell.markets.map((m) => m.code)).toEqual(["AU"]);
    expect(shell.market).toMatchObject({ code: "AU", exchange: "ASX" });
    const html = opened(shell);
    expect(html).toContain('data-market="AU"');
    expect(html).not.toMatch(/data-market="(IN|US)"/);
    expect(html).not.toContain("?market=");
  });

  it("lists every enabled market, each other market as a link, and still hides the built-off one", async () => {
    await main.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    const shell = await loadShell(await envFor(owner));
    expect(shell.markets.map((m) => m.code)).toEqual(["AU", "IN"]);
    const html = opened(shell);
    expect(html).toContain('data-market="IN"');
    expect(html).not.toContain('data-market="US"');
  });
});

describe("one resolver for every page (D-997)", () => {
  it("a market that is not enabled is a 404; none or an enabled one resolves", async () => {
    await expect(envFor(owner, undefined, "IN")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(envFor(owner, undefined, "US")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(envFor(owner, undefined, "XX")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(envFor(owner, undefined, ["AU", "IN"])).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await envFor(owner)).toMatchObject({ market: "AU", currency: "AUD" });
    expect(await envFor(owner, undefined, "AU")).toMatchObject({ market: "AU", currency: "AUD" });
  });

  it("with several markets enabled the default market is the user's own choice", async () => {
    await main.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    const uid = await addUser(auth, { email: "o@example.test", role: "owner" });
    expect(await envFor({ id: uid, role: "owner" })).toMatchObject({ market: "AU" });
    await auth.execute({
      sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, 't')",
      args: [uid, JSON.stringify({ default_market: "IN" })],
    });
    expect(await envFor({ id: uid, role: "owner" })).toMatchObject({
      market: "IN",
      currency: "INR",
    });
  });
});
