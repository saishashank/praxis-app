// @vitest-environment node
// D-309, CTX-072: updateConfig charges an Owner edit of a Cortex key as a trial (one key_edit ledger cell,
// the refit marker) and leaves every other key alone. A failed charge never turns the edit into a failure.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfig } from "@/lib/config/admin";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { refitPending } from "@/lib/cortex/store";
import { addUser, auditRows, ENV } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const T = new Date("2026-10-10T07:00:00.000Z");
let main: Client;
let auth: Client;
let ownerId: number;

beforeEach(async () => {
  invalidateConfigCache();
  main = await freshDb("main");
  auth = await freshDb("auth");
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
});

const edit = (over: Record<string, unknown> = {}, db: Client = main) =>
  updateConfig({
    mainDb: db,
    authDb: auth,
    env: ENV,
    actorId: ownerId,
    key: "cell_min_setups",
    rawValue: "80",
    reason: "test",
    now: T,
    ...over,
  });

const keyEdits = async () =>
  (
    await main.execute(
      "SELECT cell_id, spec_json FROM cortex_ledger_cell WHERE kind = 'key_edit' ORDER BY cell_id",
    )
  ).rows;

describe("updateConfig charges Cortex key edits", () => {
  it("a Cortex key edit writes one key_edit cell with before and after", async () => {
    const r = await edit();
    expect(r).toMatchObject({ ok: true });
    const rows = await keyEdits();
    expect(rows).toHaveLength(1);
    const spec = JSON.parse(String(rows[0]!.spec_json));
    expect(spec).toMatchObject({ key: "cell_min_setups", after: 80 });
  });

  it("another key writes no cell", async () => {
    await edit({ key: "retention_logs_days", rawValue: "21" });
    expect(await keyEdits()).toHaveLength(0);
  });

  it("each edit is its own charge (the version id makes the cell unique)", async () => {
    await edit();
    await edit({ rawValue: "90" });
    expect(await keyEdits()).toHaveLength(2);
  });

  it("marks the maps for a refit only when a map exists and is older than the edit", async () => {
    await edit();
    expect(await refitPending(main, "AU")).toBe(false); // no map yet: nothing to refit
    await main.execute({
      sql: `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash,
              n_eff, pool, fit_split) VALUES ('AU','F1','v1','2026-10-01T00:00:00Z','{}','h',1,'p','development')`,
      args: [],
    });
    expect(await refitPending(main, "AU")).toBe(true);
  });

  it("a failed charge is audited and the edit still succeeds", async () => {
    const broken = new Proxy(main, {
      get(target, prop, recv) {
        if (prop === "batch") return () => Promise.reject(new Error("down"));
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Client;
    const r = await edit({}, broken);
    expect(r).toMatchObject({ ok: true });
    const rows = await auditRows(auth);
    expect(rows.map((x) => String(x.action))).toContain("config.cortex_charge_failed");
  });
});
