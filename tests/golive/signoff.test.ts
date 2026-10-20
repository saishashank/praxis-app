// @vitest-environment node
// M8 T11 go-live controls (TST-122, AT-30): the sign-off writer and its server action, the `full`
// mode interlock in setMarketMode, and the Worker slots server action. Owner-only and guard-first
// for every action; audit first; confirm required; nothing changes on a refusal.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { signOffGoLiveAction } from "@/app/(app)/ops/go-live/actions";
import { setSlotsEnabledAction } from "@/app/(app)/health/slotsActions";
import { setMarketModeAction } from "@/app/(app)/health/actions";
import { setEmailMode, setMarketMode } from "@/lib/data/controls";
import { GO_LIVE_ITEM_IDS, SIGNOFF_CONFIRM_PHRASE } from "@/lib/golive/checklist";
import { deployedCommit, loadSignoffs, signOffGoLive } from "@/lib/golive/signoff";
import { fullModeRefusal, isProductionEnv } from "@/lib/golive/interlock";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
let viewerId: number;
const NOW = new Date("2026-10-21T01:00:00.000Z");
const SHA = "1234567890abcdef1234567890abcdef12345678";
const PROD = { PII_HASH_KEY: KEY, BACKUP_PUBLIC_KEY: "pub" } as Record<string, string | undefined>;
const STAGING = { PII_HASH_KEY: KEY, TEST_IDENTITY_SECRET: "t" } as Record<
  string,
  string | undefined
>;
const base = (over: Record<string, unknown> = {}) => ({
  mainDb: main,
  authDb: auth,
  env: { ...PROD, APP_COMMIT: SHA },
  actorId: ownerId,
  now: NOW,
  ...over,
});
const good = (over: Record<string, unknown> = {}) =>
  base({ items: [...GO_LIVE_ITEM_IDS], confirmation: SIGNOFF_CONFIRM_PHRASE, ...over });
const actions = async () => (await auditRows(auth)).map((r) => r.action);
const signoffs = async () => (await main.execute("SELECT * FROM go_live_signoff")).rows;
const marketMode = async () =>
  String((await main.execute("SELECT mode FROM market WHERE code = 'AU'")).rows[0]!.mode);
const setEmail = (mode: string) => setEmailMode({ ...base({ env: PROD }), mode } as never); // incidents/off are always allowed
const asUser = (id: number, role: string) =>
  requireUser.mockResolvedValue({ id, email: `${role}@example.test`, name: null, role });
const form = (o: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) {
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  return fd;
};

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("APP_COMMIT", SHA);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  viewerId = await addUser(auth, { email: "viewer@example.test", role: "viewer" });
  asUser(ownerId, "owner");
});

describe("signOffGoLive", () => {
  it("writes one row, audit first, with the release commit, the items and the note", async () => {
    const r = await signOffGoLive(good({ note: "  all done  " }) as never);
    expect(r).toEqual({ ok: true, changed: true });
    const rows = await signoffs();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      market: "AU",
      signed_by: ownerId,
      signed_at: NOW.toISOString(),
      release_commit: SHA,
      note: "all done",
    });
    expect(JSON.parse(String(rows[0]!.items_json))).toEqual(GO_LIVE_ITEM_IDS);
    const audit = await auditRows(auth);
    expect(audit.map((a) => a.action)).toEqual(["golive.signoff"]);
    expect(audit[0]!.actor_user_id).toBe(ownerId);
    expect(rows[0]!.audit_ref).toBe(`audit:${audit[0]!.id}`);
    expect(audit[0]!.detail).toMatchObject({ releaseCommit: SHA, noteLength: 8 });
    // It never switches the mode itself.
    expect(await marketMode()).toBe("data_only");
    expect((await loadSignoffs(main))[0]).toMatchObject({ releaseCommit: SHA, note: "all done" });
  });

  it("is allowed while the market is data-only; a repeat for the same commit changes nothing", async () => {
    expect(await signOffGoLive(good() as never)).toEqual({ ok: true, changed: true });
    expect(await signOffGoLive(good() as never)).toEqual({ ok: true, changed: false });
    expect((await signoffs()).length).toBe(1);
    expect((await actions()).length).toBe(1);
  });

  it("refuses a non-Owner, a missing user and an invited or revoked Owner row, writing nothing", async () => {
    for (const actorId of [editorId, viewerId, 9999]) {
      expect(await signOffGoLive(good({ actorId }) as never)).toEqual({
        ok: false,
        error: "forbidden",
      });
    }
    expect(await signoffs()).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it("requires EVERY item: any missing one is refused with items_missing", async () => {
    for (const drop of GO_LIVE_ITEM_IDS) {
      const items = GO_LIVE_ITEM_IDS.filter((i) => i !== drop);
      expect(await signOffGoLive(good({ items }) as never), drop).toEqual({
        ok: false,
        error: "items_missing",
      });
    }
    expect(await signOffGoLive(good({ items: [] }) as never)).toEqual({
      ok: false,
      error: "items_missing",
    });
    expect(await signoffs()).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it("requires the exact typed confirmation", async () => {
    for (const confirmation of [
      undefined,
      "",
      "sign off go-live",
      `${SIGNOFF_CONFIRM_PHRASE} `,
      "yes",
      true,
    ]) {
      expect(await signOffGoLive(good({ confirmation }) as never)).toEqual({
        ok: false,
        error: "confirm_required",
      });
    }
    expect(await signoffs()).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it("refuses malformed input: unknown or duplicate items, a long or odd note, a bad commit", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ items: [...GO_LIVE_ITEM_IDS, "extra"] }, "invalid"],
      [{ items: [...GO_LIVE_ITEM_IDS, GO_LIVE_ITEM_IDS[0]] }, "invalid"],
      [{ items: "all" }, "invalid"],
      [{ items: [1, 2] }, "invalid"],
      [{ items: null }, "invalid"],
      [{ note: "x".repeat(501) }, "invalid"],
      [{ note: 5 }, "invalid"],
      [{ note: "bad\u0000char" }, "invalid"],
      [{ env: { ...PROD }, commit: undefined }, "commit_unknown"],
      [{ env: { ...PROD }, commit: "XYZ" }, "commit_unknown"],
      [{ env: { ...PROD }, commit: "abc12" }, "commit_unknown"],
    ];
    for (const [over, error] of cases) {
      expect(await signOffGoLive(good(over) as never), JSON.stringify(over)).toEqual({
        ok: false,
        error,
      });
    }
    expect(await signOffGoLive(good({ note: "x".repeat(500) }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await actions()).toEqual(["golive.signoff"]);
  });

  it("uses a typed commit only when the deployment reports none; the deployed one wins", async () => {
    const typed = "ABCDEF1234";
    expect(await signOffGoLive(good({ env: { ...PROD }, commit: typed }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect((await signoffs())[0]!.release_commit).toBe("abcdef1234");
    expect(deployedCommit({ APP_COMMIT: "ZZZ", VERCEL_GIT_COMMIT_SHA: SHA })).toBe(SHA);
    expect(deployedCommit({})).toBeNull();
    // a second sign-off for another commit appends (never edits)
    expect(await signOffGoLive(good({ commit: "0000000" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect((await signoffs()).length).toBe(2);
  });

  it("audit first: a failing insert leaves the audit row and a _failed row and no sign-off", async () => {
    await main.execute(
      "CREATE TRIGGER boom BEFORE INSERT ON go_live_signoff BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(await signOffGoLive(good() as never)).toEqual({ ok: false, error: "unavailable" });
    expect(await signoffs()).toEqual([]);
    expect(await actions()).toEqual(["golive.signoff", "golive.signoff_failed"]);
  });

  it("nothing is written when the audit write fails", async () => {
    expect(await signOffGoLive(good({ env: { APP_COMMIT: SHA } }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await signoffs()).toEqual([]);
  });
});

describe("signOffGoLiveAction (guard first)", () => {
  const ticked = { item: [...GO_LIVE_ITEM_IDS], confirmation: SIGNOFF_CONFIRM_PHRASE };

  it("asks for the admin (Owner) action before anything else, on the page path", async () => {
    await signOffGoLiveAction(form(ticked));
    expect(requireUser).toHaveBeenCalledWith("admin", "/ops/go-live");
  });

  it("a non-Owner is refused by the guard: nothing is written, audited or revalidated", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(signOffGoLiveAction(form(ticked))).rejects.toThrow(/403/);
    expect(await signoffs()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("even a guard that wrongly let an Editor through is stopped by the writer", async () => {
    asUser(editorId, "editor");
    expect(await signOffGoLiveAction(form(ticked))).toEqual({ error: "forbidden" });
    expect(await signoffs()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("the Owner signs off and the pages are revalidated; a short form is refused", async () => {
    expect(await signOffGoLiveAction(form({ ...ticked, item: ["pat_revoked"] }))).toEqual({
      error: "items_missing",
    });
    expect(await signOffGoLiveAction(form({ ...ticked, confirmation: "no" }))).toEqual({
      error: "confirm_required",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await signOffGoLiveAction(form({ ...ticked, note: "ok" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/ops/go-live");
    expect((await signoffs()).length).toBe(1);
  });
});

describe("the full-mode interlock (decision 33)", () => {
  const full = (env: Record<string, string | undefined>) =>
    setMarketMode({ ...base({ env }), market: "AU", mode: "full" } as never);
  const markSigned = () => signOffGoLive(good() as never);

  it("production: refused without a sign-off, then with email off; nothing changes, no audit", async () => {
    expect(await full(PROD)).toEqual({ ok: false, error: "signoff_required" });
    expect(await marketMode()).toBe("data_only");
    await markSigned();
    const before = await actions();
    expect(await full(PROD)).toEqual({ ok: false, error: "email_off" });
    expect(await marketMode()).toBe("data_only");
    expect(await actions()).toEqual(before);
    const cfg = await main.execute(
      "SELECT COUNT(*) AS n FROM config_version WHERE key = 'market_mode'",
    );
    expect(cfg.rows[0]!.n).toBe(0);
  });

  it("production: passes with a sign-off row and email incidents; writes the column and the config", async () => {
    await markSigned();
    expect(await setEmail("incidents")).toEqual({ ok: true, changed: true });
    expect(await full(PROD)).toEqual({ ok: true, changed: true });
    expect(await marketMode()).toBe("full");
    expect((await actions()).slice(-1)).toEqual(["controls.market_mode"]);
    const cfg = await main.execute(
      "SELECT value_json FROM config_version WHERE key = 'market_mode'",
    );
    expect(JSON.parse(String(cfg.rows[0]!.value_json))).toEqual({ AU: "full" });
    // leaving full is always allowed
    expect(
      await setMarketMode({ ...base({ env: PROD }), market: "AU", mode: "data_only" } as never),
    ).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("a sign-off for another market does not count", async () => {
    await main.execute(
      "INSERT INTO go_live_signoff (market, signed_by, signed_at, release_commit, items_json, note, audit_ref) VALUES ('US', 1, 't', 'abcdef1', '[]', '', 'a')",
    );
    expect(await setEmail("incidents")).toEqual({ ok: true, changed: true });
    expect(await full(PROD)).toEqual({ ok: false, error: "signoff_required" });
  });

  it("an environment that is not positively staging counts as production (fail closed)", async () => {
    expect(isProductionEnv({})).toBe(true);
    expect(isProductionEnv({ PRAXIS_ENV: "staging" })).toBe(true);
    expect(isProductionEnv({ TEST_IDENTITY_SECRET: "t", BACKUP_PUBLIC_KEY: "k" })).toBe(true);
    expect(isProductionEnv(STAGING)).toBe(false);
    expect(await full({ PII_HASH_KEY: KEY })).toEqual({ ok: false, error: "signoff_required" });
    expect(await marketMode()).toBe("data_only");
  });

  it("staging is free: no row and email off still pass", async () => {
    expect(await full(STAGING)).toEqual({ ok: true, changed: true });
    expect(await marketMode()).toBe("full");
    expect(await fullModeRefusal(main, STAGING, "AU", "2026-10-21")).toBeNull();
  });

  it("fullModeRefusal reports each missing condition in turn (signoff first, then email)", async () => {
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBe("signoff_required");
    await markSigned();
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBe("email_off");
    await setEmail("incidents");
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBeNull();
  });

  it("the Owner action refuses an Editor and bad input without auditing", async () => {
    expect(
      await setMarketMode({
        ...base({ env: STAGING, actorId: editorId }),
        market: "AU",
        mode: "full",
      } as never),
    ).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await setMarketMode({ ...base({ env: STAGING }), market: "AU", mode: "fully" } as never),
    ).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await actions()).toEqual([]);
  });

  it("the System Health action carries the same refusal codes", async () => {
    vi.stubEnv("BACKUP_PUBLIC_KEY", "pub");
    expect(await setMarketModeAction(form({ market: "AU", mode: "full" }))).toEqual({
      error: "signoff_required",
    });
    expect(await marketMode()).toBe("data_only");
  });
});

describe("email cannot be switched off while a market is full (production)", () => {
  const mode = (env: Record<string, string | undefined>, m: string) =>
    setEmailMode({ ...base({ env }), mode: m } as never);
  const setFull = () => main.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");

  it("production: refused while AU is full, nothing written, no audit", async () => {
    expect(await mode(PROD, "incidents")).toEqual({ ok: true, changed: true });
    await setFull();
    const before = await actions();
    expect(await mode(PROD, "off")).toEqual({ ok: false, error: "market_full" });
    const r = await main.execute("SELECT value_json FROM worker_state WHERE key = 'email_mode'");
    expect(r.rows[0]!.value_json).toBe('"incidents"');
    expect(await actions()).toEqual(before);
  });

  it("allowed when AU is data_only, and on staging even while full", async () => {
    expect(await mode(PROD, "incidents")).toEqual({ ok: true, changed: true });
    expect(await mode(PROD, "off")).toEqual({ ok: true, changed: true });
    expect(await mode(STAGING, "incidents")).toEqual({ ok: true, changed: true });
    await setFull();
    expect(await mode(STAGING, "off")).toEqual({ ok: true, changed: true });
  });
});

describe("setSlotsEnabledAction (guard first)", () => {
  const f = (o: Record<string, string | string[]> = {}) =>
    form({ slot: ["morning", "pre-open"], confirm: "yes", ...o });

  it("asks for the admin (Owner) action first, on the health path", async () => {
    await setSlotsEnabledAction(f());
    expect(requireUser).toHaveBeenCalledWith("admin", "/health");
  });

  it("a non-Owner is refused by the guard: nothing written, audited or revalidated", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(setSlotsEnabledAction(f())).rejects.toThrow(/403/);
    expect(await auditRows(auth)).toEqual([]);
    expect(
      (await main.execute("SELECT 1 FROM worker_state WHERE key = 'slots_enabled'")).rows,
    ).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an Editor or Viewer that reached the writer is refused by it", async () => {
    for (const [id, role] of [
      [editorId, "editor"],
      [viewerId, "viewer"],
    ] as const) {
      asUser(id, role);
      expect(await setSlotsEnabledAction(f())).toEqual({ error: "forbidden" });
    }
    expect(await auditRows(auth)).toEqual([]);
  });

  it("the Owner saves the list with confirm, and is refused without it or with a bad id", async () => {
    expect(await setSlotsEnabledAction(f({ confirm: "no" }))).toEqual({
      error: "confirm_required",
    });
    expect(await setSlotsEnabledAction(f({ slot: ["backup"] }))).toEqual({ error: "invalid" });
    expect(await auditRows(auth)).toEqual([]);
    expect(await setSlotsEnabledAction(f())).toEqual({ ok: true, changed: true });
    expect(revalidatePath).toHaveBeenCalledWith("/health");
    const r = await main.execute("SELECT value_json FROM worker_state WHERE key = 'slots_enabled'");
    expect(r.rows[0]!.value_json).toBe('["morning","pre-open"]');
  });
});
