// @vitest-environment node
// M8 T11 Worker slots: the shared list equals worker/src/schedule.ts (decision 32, D-155), and the
// Owner writer (setSlotsEnabled): Owner-only, confirm, audit first, exact JSON, malformed refused.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { AU_SLOTS } from "../../worker/src/schedule";
import { parseSlotsEnabled } from "../../worker/src/clock";
import {
  ALWAYS_ON_SLOTS,
  GO_LIVE_SLOT_IDS,
  GO_LIVE_SLOTS,
  loadSlotsView,
  setSlotsEnabled,
  slotsJson,
} from "@/lib/golive/slots";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const NOW = new Date("2026-10-21T01:00:00.000Z");
const base = (over: Record<string, unknown> = {}) => ({
  mainDb: main,
  authDb: auth,
  env: { PII_HASH_KEY: KEY } as Record<string, string | undefined>,
  actorId: ownerId,
  now: NOW,
  slots: ["morning", "pre-open"],
  confirmed: true,
  ...over,
});
const stored = async () => {
  const r = await main.execute("SELECT value_json FROM worker_state WHERE key = 'slots_enabled'");
  return r.rows.length ? String(r.rows[0]!.value_json) : null;
};
const actions = async () => (await auditRows(auth)).map((r) => r.action);

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
});

describe("the shared slot list equals the Worker table", () => {
  const gated = AU_SLOTS.filter((s) => s.requiresListing === true);
  it("has exactly the requiresListing slots, with their times, in time-of-day order", () => {
    expect(new Set(GO_LIVE_SLOT_IDS)).toEqual(new Set(gated.map((s) => s.id)));
    expect(GO_LIVE_SLOT_IDS.length).toBe(gated.length);
    for (const s of GO_LIVE_SLOTS) {
      expect(gated.find((g) => g.id === s.id)?.time, s.id).toBe(s.time);
    }
    // 07:00 onwards, then the after-midnight replay last (PLT-073 day order).
    const rank = (t: string) => (t < "07:00" ? 1 : 0) * 10_000 + Number(t.replace(":", ""));
    expect(GO_LIVE_SLOTS.map((s) => rank(s.time))).toEqual(
      [...GO_LIVE_SLOTS.map((s) => rank(s.time))].sort((a, b) => a - b),
    );
  });
  it("the always-on slots are real Worker slots that are not gated", () => {
    for (const id of ALWAYS_ON_SLOTS) {
      const s = AU_SLOTS.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      expect(s!.requiresListing, id).not.toBe(true);
    }
    expect(GO_LIVE_SLOT_IDS.some((id) => ALWAYS_ON_SLOTS.includes(id))).toBe(false);
  });
});

describe("setSlotsEnabled", () => {
  it("writes the list exactly as a JSON array in canonical order and the Worker reads it", async () => {
    const r = await setSlotsEnabled(base({ slots: ["pre-open", "morning"] }) as never);
    expect(r).toEqual({ ok: true, changed: true });
    expect(await stored()).toBe('["morning","pre-open"]');
    const parsed = parseSlotsEnabled(await stored());
    expect(parsed.kind).toBe("list");
    expect(await actions()).toEqual(["controls.slots_enabled"]);
    const row = (await auditRows(auth))[0]!;
    expect(row.actor_user_id).toBe(ownerId);
    expect(row.detail).toEqual({ from: null, to: '["morning","pre-open"]' });
    expect(await loadSlotsView(main)).toEqual({
      listed: ["morning", "pre-open"],
      malformed: false,
    });
  });

  it("an empty list is valid (every go-live slot off); the same list again changes nothing", async () => {
    expect(await setSlotsEnabled(base({ slots: [] }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await stored()).toBe("[]");
    const before = (await auditRows(auth)).length;
    expect(await setSlotsEnabled(base({ slots: [] }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect((await auditRows(auth)).length).toBe(before);
  });

  it("a non-Owner is refused before anything is written or audited", async () => {
    expect(await setSlotsEnabled(base({ actorId: editorId }) as never)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await setSlotsEnabled(base({ actorId: 9999 }) as never)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await stored()).toBeNull();
    expect(await actions()).toEqual([]);
  });

  it("confirm is required: nothing but true passes", async () => {
    for (const confirmed of [false, undefined, "yes", 1, null]) {
      expect(await setSlotsEnabled(base({ confirmed }) as never)).toEqual({
        ok: false,
        error: "confirm_required",
      });
    }
    expect(await stored()).toBeNull();
    expect(await actions()).toEqual([]);
  });

  it("malformed input is refused: unknown, always-on, duplicate, non-string, not a list", async () => {
    for (const slots of [
      ["nope"],
      ["backup"],
      ["maintenance"],
      ["ingest-batch1"],
      ["morning", "morning"],
      [1],
      [null],
      "morning",
      null,
      undefined,
      { 0: "morning" },
      [...GO_LIVE_SLOT_IDS, "morning"],
    ]) {
      expect(await setSlotsEnabled(base({ slots }) as never), JSON.stringify(slots)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await stored()).toBeNull();
    expect(await actions()).toEqual([]);
  });

  it("audit first: a failing write leaves the audit row and a _failed row, and no list", async () => {
    await main.execute(
      "CREATE TRIGGER boom BEFORE INSERT ON worker_state WHEN NEW.key = 'slots_enabled' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(await setSlotsEnabled(base() as never)).toEqual({ ok: false, error: "unavailable" });
    expect(await stored()).toBeNull();
    expect(await actions()).toEqual(["controls.slots_enabled", "controls.slots_enabled_failed"]);
  });

  it("nothing is written when the audit write fails", async () => {
    const bad = base({ env: {} }); // no PII_HASH_KEY: the audit key is missing
    expect(await setSlotsEnabled(bad as never)).toEqual({ ok: false, error: "unavailable" });
    expect(await stored()).toBeNull();
  });

  it("works while the market is data-only (it is how slots are listed before full)", async () => {
    expect((await main.execute("SELECT mode FROM market WHERE code = 'AU'")).rows[0]!.mode).toBe(
      "data_only",
    );
    expect(await setSlotsEnabled(base() as never)).toEqual({ ok: true, changed: true });
  });

  it("slotsJson drops unknown ids and orders by the day", () => {
    expect(slotsJson(["replay", "x", "alert-flush"])).toBe('["alert-flush","replay"]');
  });

  it("loadSlotsView reports absent, null and malformed values", async () => {
    expect(await loadSlotsView(main)).toEqual({ listed: null, malformed: false });
    const put = (v: string) =>
      main.execute({
        sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('slots_enabled', ?, 't') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
        args: [v],
      });
    await put("null");
    expect(await loadSlotsView(main)).toEqual({ listed: null, malformed: false });
    await put("{bad");
    expect(await loadSlotsView(main)).toEqual({ listed: null, malformed: true });
    await put('{"a":1}');
    expect(await loadSlotsView(main)).toEqual({ listed: null, malformed: true });
  });
});
