// @vitest-environment node
// KB version helper, the v1 rule_version seed and the read-only lock on the Lane-B keys (M6 T2;
// LLM-031, KB-010..012, M6 decisions 10, 32 and 45 / D-110).
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { FAMILY_ORDER } from "@/lib/agents/families/constants";
import {
  FAMILY_PARAM_KEYS,
  FAMILY_SPECS,
  validateRuleSpec,
} from "@/lib/agents/families/ruleSchema";
import { updateConfig } from "@/lib/config/admin";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import { getConfig, setConfig } from "@/lib/config/store";
import {
  configEditRefusal,
  B_KEY_LOCKED_MESSAGE,
  ruleVersionsSeeded,
} from "@/lib/learning/bKeyLock";
import {
  KB_VERSION_EMPTY,
  currentKbVersion,
  currentKbVersionId,
  formatKbVersion,
  parseKbVersion,
} from "@/lib/learning/kbVersion";
import {
  canonicalParams,
  paramsSha,
  RuleVersionError,
  seedRuleVersions,
} from "@/lib/learning/ruleVersions";
import { CHANGE_KINDS, CONTEXT_CHANGE_KINDS } from "@/lib/learning/schema";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

type V = string | number | null;
const q = async (db: Client, sql: string, args: V[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

const ledger = (db: Client, kind: string, market = "AU") =>
  db.execute({
    sql: `INSERT INTO change_ledger (market, kind, target, effective_d, actor, created_at)
          VALUES (?, ?, 't', '2026-10-20', 'A6', '2026-10-20T08:00:00.000Z')`,
    args: [market, kind],
  });

describe("KB version (LLM-031)", () => {
  it("is kb-0 on an empty ledger and kb-<id> of the latest context-changing row", async () => {
    const db = await freshDb("main");
    expect(await currentKbVersion(db)).toBe(KB_VERSION_EMPTY);
    expect(await currentKbVersionId(db)).toBe(0);
    await ledger(db, "lane_a_playbook");
    expect(await currentKbVersion(db)).toBe("kb-1");
    await ledger(db, "promotion");
    expect(await currentKbVersion(db)).toBe("kb-2");
  });

  it("a kill-switch freeze changes no prompt, so it does not move the version", async () => {
    const db = await freshDb("main");
    await ledger(db, "lane_a_note");
    await ledger(db, "kill_freeze");
    expect(await currentKbVersion(db)).toBe("kb-1");
    expect(CONTEXT_CHANGE_KINDS).not.toContain("kill_freeze");
    for (const k of CHANGE_KINDS.filter((x) => x !== "kill_freeze")) {
      expect(CONTEXT_CHANGE_KINDS, k).toContain(k);
    }
  });

  it("every context-changing kind moves the version; the id never goes back", async () => {
    const db = await freshDb("main");
    let last = 0;
    for (const k of CONTEXT_CHANGE_KINDS) {
      await ledger(db, k);
      const now = await currentKbVersionId(db);
      expect(now, k).toBeGreaterThan(last);
      last = now;
    }
  });

  it("can be limited to one market", async () => {
    const db = await freshDb("main");
    await ledger(db, "lane_a_playbook", "AU");
    await ledger(db, "lane_a_playbook", "IN");
    expect(await currentKbVersion(db, "AU")).toBe("kb-1");
    expect(await currentKbVersion(db, "IN")).toBe("kb-2");
    expect(await currentKbVersion(db, "US")).toBe("kb-0");
    expect(await currentKbVersion(db)).toBe("kb-2");
  });

  it("formats and parses; refuses a bad id or text", () => {
    expect(formatKbVersion(12)).toBe("kb-12");
    expect(() => formatKbVersion(-1)).toThrow(RangeError);
    expect(() => formatKbVersion(1.5)).toThrow(RangeError);
    expect(parseKbVersion("kb-12")).toBe(12);
    expect(parseKbVersion("kb-0")).toBe(0);
    for (const bad of ["kb-", "kb-01", "KB-1", "kb-1.5", "x", "kb--1"]) {
      expect(parseKbVersion(bad), bad).toBeNull();
    }
  });
});

describe("v1 rule_version seed (KB-012)", () => {
  const D = "2026-10-20";

  it("seeds F1-F6 v1 from the registry with origin seed, no parent, full canonical params and a valid spec", async () => {
    const db = await freshDb("main");
    const r = await seedRuleVersions(db, { market: "AU", d: D });
    expect(r.inserted).toEqual(["F1.v1", "F2.v1", "F3.v1", "F4.v1", "F5.v1", "F6.v1"]);
    expect(r.unchanged).toEqual([]);
    const rows = await q(db, "SELECT * FROM rule_version ORDER BY id");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const fam = String(row.family) as (typeof FAMILY_ORDER)[number];
      expect(row.n).toBe(1);
      expect(row.parent).toBeNull();
      expect(row.origin).toBe("seed");
      expect(row.registered_d).toBe(D);
      const params = JSON.parse(String(row.params_json)) as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([...FAMILY_PARAM_KEYS[fam]].sort());
      for (const k of Object.keys(params)) {
        expect(params[k], k).toEqual(
          (CONFIG_KEYS as Record<string, { default: unknown }>)[k].default,
        );
      }
      expect(row.params_sha).toBe(paramsSha(params));
      expect(validateRuleSpec(JSON.parse(String(row.spec_json)), params)).toEqual([]);
      expect(JSON.parse(String(row.spec_json))).toEqual(FAMILY_SPECS[fam]);
    }
    const status = await q(
      db,
      "SELECT rule_version_id, seq, status FROM rule_version_status ORDER BY 1, 2",
    );
    expect(status).toHaveLength(12);
    expect(status.filter((s) => s.seq === 1).every((s) => s.status === "registered")).toBe(true);
    expect(status.filter((s) => s.seq === 2).every((s) => s.status === "live")).toBe(true);
  });

  it("is idempotent: a second seed inserts nothing and leaves the rows unchanged", async () => {
    const db = await freshDb("main");
    await seedRuleVersions(db, { market: "AU", d: D });
    const before = await q(db, "SELECT * FROM rule_version ORDER BY id");
    const r = await seedRuleVersions(db, { market: "AU", d: "2026-10-27" });
    expect(r.inserted).toEqual([]);
    expect(r.unchanged).toHaveLength(6);
    expect(await q(db, "SELECT * FROM rule_version ORDER BY id")).toEqual(before);
    expect(await q(db, "SELECT COUNT(*) AS n FROM rule_version_status")).toEqual([{ n: 12 }]);
  });

  it("raises when a stored version differs from the registry values (versions are immutable)", async () => {
    const db = await freshDb("main");
    await seedRuleVersions(db, { market: "AU", d: D });
    const value = (k: ConfigKey): unknown => (k === "f1_trail_atr" ? 3.5 : CONFIG_KEYS[k].default);
    await expect(seedRuleVersions(db, { market: "AU", d: D, value })).rejects.toThrow(
      RuleVersionError,
    );
    await expect(seedRuleVersions(db, { market: "AU", d: D, value })).rejects.toThrow(
      /F1.v1: stored parameters differ/,
    );
  });

  it("refuses to seed a value outside its bounds and writes nothing (one transaction)", async () => {
    const db = await freshDb("main");
    const value = (k: ConfigKey): unknown => (k === "f4_stop_atr" ? 9 : CONFIG_KEYS[k].default);
    await expect(seedRuleVersions(db, { market: "AU", d: D, value })).rejects.toThrow(
      /outside bounds/,
    );
    expect(await q(db, "SELECT COUNT(*) AS n FROM rule_version")).toEqual([{ n: 0 }]);
    expect(await q(db, "SELECT COUNT(*) AS n FROM rule_version_status")).toEqual([{ n: 0 }]);
  });

  it("seeds from supplied values (a stored configuration) and the hash follows them", async () => {
    const db = await freshDb("main");
    const value = (k: ConfigKey): unknown => (k === "f1_trail_atr" ? 3.5 : CONFIG_KEYS[k].default);
    await seedRuleVersions(db, { market: "AU", d: D, value });
    const row = (
      await q(db, "SELECT params_json, params_sha FROM rule_version WHERE id = 'F1.v1'")
    )[0]!;
    expect((JSON.parse(String(row.params_json)) as Record<string, unknown>).f1_trail_atr).toBe(3.5);
    expect(row.params_sha).toBe(paramsSha(canonicalParams("F1", value)));
  });

  it("the canonical form is key-sorted, so the same values hash the same in any order", () => {
    expect(paramsSha({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      paramsSha({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    expect(paramsSha({ a: 1 })).not.toBe(paramsSha({ a: 2 }));
  });
});

describe("Lane-B keys are read-only after the seed (decision 45)", () => {
  const D = "2026-10-20";

  it("before the seed a B key is editable; after it the store and the editor refuse", async () => {
    const db = await freshDb("main");
    expect(await ruleVersionsSeeded(db)).toBe(false);
    expect(await configEditRefusal(db, "f1_trail_atr")).toBeNull();
    await setConfig(db, {
      key: "f1_trail_atr",
      value: 3.5,
      userId: null,
      now: "2026-10-20T00:00:00.000Z",
    });
    expect(await getConfig(db, "f1_trail_atr")).toBe(3.5);

    await seedRuleVersions(db, {
      market: "AU",
      d: D,
      value: (k) => (k === "f1_trail_atr" ? 3.5 : CONFIG_KEYS[k].default),
    });
    expect(await ruleVersionsSeeded(db)).toBe(true);
    expect(await configEditRefusal(db, "f1_trail_atr")).toBe(B_KEY_LOCKED_MESSAGE);
    await expect(
      setConfig(db, {
        key: "f1_trail_atr",
        value: 3,
        userId: null,
        now: "2026-10-21T00:00:00.000Z",
      }),
    ).rejects.toThrow(/new rule version/);
    expect(await getConfig(db, "f1_trail_atr")).toBe(3.5);
    // every B key is covered, including the object key and the shared ones
    for (const k of [
      "insider_score_weights",
      "reentry_block",
      "event_polarity_threshold_pct",
      "f6_min_classes",
    ]) {
      expect(await configEditRefusal(db, k), k).toBe(B_KEY_LOCKED_MESSAGE);
    }
  });

  it("Owner keys and fixed keys are unaffected by the lock", async () => {
    const db = await freshDb("main");
    await seedRuleVersions(db, { market: "AU", d: D });
    expect(await configEditRefusal(db, "max_challengers")).toBeNull();
    expect(await configEditRefusal(db, "regime_params")).toBeNull();
    await setConfig(db, {
      key: "max_challengers",
      value: 6,
      userId: null,
      now: "2026-10-21T00:00:00.000Z",
    });
    expect(await getConfig(db, "max_challengers")).toBe(6);
  });

  it("updateConfig (the Owner editor) answers 'fixed' with the lock text for a B key after the seed", async () => {
    const db = await freshDb("main");
    const authDb = await freshDb("auth");
    await authDb.execute({
      sql: `INSERT INTO app_user (id, email, role, status, created_at, updated_at)
            VALUES (1, 'owner@example.test', 'owner', 'active', 'x', 'x')`,
      args: [],
    });
    await seedRuleVersions(db, { market: "AU", d: D });
    const res = await updateConfig({
      mainDb: db,
      authDb,
      env: {} as never,
      actorId: 1,
      key: "f1_trail_atr",
      rawValue: "3.5",
      reason: "test",
    });
    expect(res).toEqual({ ok: false, error: "fixed", message: B_KEY_LOCKED_MESSAGE });
    expect(await getConfig(db, "f1_trail_atr")).toBe(CONFIG_KEYS.f1_trail_atr.default);
  });
});
