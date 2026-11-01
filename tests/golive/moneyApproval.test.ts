// @vitest-environment node
// R2-S2 (D-805): the money-figure approval is an audited Owner attestation (data), not a code change.
// The interlock accepts `full` in production once the attestation covers every figure still unverified
// in code; a figure added later blocks again. Owner only, confirm phrase, audit first, no migration.
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

import { approveMoneyConstantsAction } from "@/app/(app)/ops/go-live/actions";
import { setEmailMode, setMarketMode } from "@/lib/data/controls";
import { GO_LIVE_ITEM_IDS, SIGNOFF_CONFIRM_PHRASE } from "@/lib/golive/checklist";
import { fullModeRefusal } from "@/lib/golive/interlock";
import {
  approveMoneyConstants,
  MONEY_APPROVAL_PHRASE,
  readMoneyApproval,
  uncoveredByApproval,
} from "@/lib/golive/moneyApproval";
import {
  canonicalJson,
  moneyConstants,
  moneyValueHashes,
  unverifiedMoneyConstants,
} from "@/lib/golive/moneyConstants";
import { signOffGoLive } from "@/lib/golive/signoff";

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const NOW = new Date("2026-10-21T01:00:00.000Z");
const SHA = "1234567890abcdef1234567890abcdef12345678";
const PROD = { PII_HASH_KEY: KEY, BACKUP_PUBLIC_KEY: "pub" } as Record<string, string | undefined>;
const IDS = () => moneyConstants().map((c) => c.id);
const base = (over: Record<string, unknown> = {}) => ({
  mainDb: main,
  authDb: auth,
  env: { ...PROD, APP_COMMIT: SHA },
  actorId: ownerId,
  now: NOW,
  ...over,
});
const good = (over: Record<string, unknown> = {}) =>
  base({ ids: IDS(), confirmation: MONEY_APPROVAL_PHRASE, ...over });
const rows = async () =>
  (await main.execute("SELECT * FROM config_version WHERE key = 'money_constants_approved'")).rows;
const form = (ids: string[], confirmation: string): FormData => {
  const fd = new FormData();
  for (const id of ids) fd.append("id", id);
  fd.append("confirmation", confirmation);
  return fd;
};

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  requireUser.mockResolvedValue({
    id: ownerId,
    email: "o@example.test",
    name: null,
    role: "owner",
  });
});
afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

describe("approveMoneyConstants", () => {
  it("writes one append-only config row, audit first, naming every figure", async () => {
    expect(await approveMoneyConstants(good() as never)).toEqual({ ok: true, changed: true });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(JSON.parse(String(r[0]!.value_json)).ids.sort()).toEqual([...IDS()].sort());
    expect(r[0]).toMatchObject({ changed_by_user_id: ownerId, changed_at: NOW.toISOString() });
    const audit = await auditRows(auth);
    expect(audit.map((a) => a.action)).toEqual(["golive.money_constants_approved"]);
    expect(String(r[0]!.reason)).toContain(`audit:${audit[0]!.id}`);
    expect((await readMoneyApproval(main))?.ids.sort()).toEqual([...IDS()].sort());
  });

  it("a repeat changes nothing", async () => {
    await approveMoneyConstants(good() as never);
    expect(await approveMoneyConstants(good() as never)).toEqual({ ok: true, changed: false });
    expect(await rows()).toHaveLength(1);
    expect((await auditRows(auth)).length).toBe(1);
  });

  it("refuses an Editor, a wrong phrase and a stale or malformed list, writing nothing", async () => {
    for (const [over, error] of [
      [{ actorId: editorId }, "forbidden"],
      [{ confirmation: "yes" }, "confirm_required"],
      [{ ids: IDS().slice(1) }, "invalid"],
      [{ ids: "x" }, "invalid"],
    ] as const) {
      expect(await approveMoneyConstants(good(over) as never), error).toEqual({
        ok: false,
        error,
      });
    }
    expect(await rows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("the interlock reads the attestation (the code flags stay informational)", () => {
  const signed = async () => {
    await signOffGoLive({
      ...base(),
      items: [...GO_LIVE_ITEM_IDS],
      confirmation: SIGNOFF_CONFIRM_PHRASE,
    } as never);
    await setEmailMode({ ...base(), mode: "incidents" } as never);
  };

  it("production full is refused until the Owner approves, then allowed; the flags never change", async () => {
    await signed();
    expect(unverifiedMoneyConstants().length).toBeGreaterThan(0);
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBe("constants_unverified");
    expect(await approveMoneyConstants(good() as never)).toEqual({ ok: true, changed: true });
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBeNull();
    const r = await setMarketMode({ ...base({ env: PROD }), market: "AU", mode: "full" } as never);
    expect(r).toEqual({ ok: true, changed: true });
    expect(unverifiedMoneyConstants().length).toBeGreaterThan(0);
  });

  it("a figure added after the approval blocks full again", async () => {
    await signed();
    await approveMoneyConstants(good() as never);
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21", [...IDS(), "new_figure"])).toBe(
      "constants_unverified",
    );
    expect(await uncoveredByApproval(main, [...IDS(), "new_figure"])).toEqual(["new_figure"]);
  });

  it("R3-I2: the row stores id + value hash, and a changed value under the same id re-blocks full", async () => {
    await signed();
    await approveMoneyConstants(good() as never);
    const stored = JSON.parse(String((await rows())[0]!.value_json)) as {
      items: { id: string; valueHash: string }[];
    };
    const now = moneyValueHashes();
    expect(stored.items.map((i) => i.id).sort()).toEqual([...IDS()].sort());
    for (const it of stored.items) expect(it.valueHash).toBe(now[it.id]);
    expect(Object.values(now).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(await uncoveredByApproval(main, IDS())).toEqual([]);
    // the same id with a different value (a later code change) is no longer covered
    const changed = { ...now, min_parcel: "0".repeat(64) };
    expect(await uncoveredByApproval(main, IDS(), changed)).toEqual(["min_parcel"]);
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBeNull();
    // a row written before hashes existed (ids only) covers nothing: fail closed
    await main.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('money_constants_approved', 'global', ?, 'x')",
      args: [JSON.stringify({ ids: IDS() })],
    });
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBe("constants_unverified");
  });

  it("R3-I2: re-approving after a value change writes a new row; an unchanged repeat does not", async () => {
    await approveMoneyConstants(good() as never);
    await main.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('money_constants_approved', 'global', ?, 'x')",
      args: [
        JSON.stringify({
          ids: IDS(),
          items: IDS().map((id) => ({ id, valueHash: "f".repeat(64) })),
        }),
      ],
    });
    expect(await approveMoneyConstants(good() as never)).toEqual({ ok: true, changed: true });
    expect(await rows()).toHaveLength(3);
    expect(await approveMoneyConstants(good() as never)).toEqual({ ok: true, changed: false });
  });

  it("canonicalJson is key-order independent and writes bigint distinctly", () => {
    expect(canonicalJson({ b: 1n, a: [2n, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2n, { c: 2, d: 1 }], b: 1n }),
    );
    expect(canonicalJson({ a: 1n })).not.toBe(canonicalJson({ a: 1 }));
  });

  it("an unreadable attestation row fails closed", async () => {
    await signed();
    await main.execute(
      `INSERT INTO config_version (key, scope, value_json, changed_at)
       VALUES ('money_constants_approved', 'global', '{"ids":5}', 'x')`,
    );
    expect(await readMoneyApproval(main)).toBeNull();
    expect(await fullModeRefusal(main, PROD, "AU", "2026-10-21")).toBe("constants_unverified");
  });
});

describe("approveMoneyConstantsAction", () => {
  it("is guard-first (admin), audited and revalidates; a bad phrase is an error", async () => {
    expect(await approveMoneyConstantsAction(form(IDS(), "nope"))).toEqual({
      error: "confirm_required",
    });
    expect(requireUser).toHaveBeenCalledWith("admin", "/ops/go-live");
    expect(await approveMoneyConstantsAction(form(IDS(), MONEY_APPROVAL_PHRASE))).toEqual({
      ok: true,
      changed: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/ops/go-live");
    expect((await auditRows(auth)).map((a) => a.action)).toEqual([
      "golive.money_constants_approved",
    ]);
  });

  it("a guard refusal stops before anything is written", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(approveMoneyConstantsAction(form(IDS(), MONEY_APPROVAL_PHRASE))).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });
});
