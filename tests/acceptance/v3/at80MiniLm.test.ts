// @vitest-environment node
// AT-80 (MiniLM part, M22 L5; LLM-079, D-1414…D-1416; PRD-033): the small local reader in shadow.
//  - shadow ON versus OFF on the golden AT-32 world: every table outside the own-set (the complement) is byte-identical, so the
//    reader moves no decision input (the complement proof of tests/acceptance/v3/at32Opinions.test.ts, with the stage real);
//  - ON writes its rows and the night's agreement figure is published (run summary and the System Health line);
//  - with the committed files (no trained head, no pinned model) the setting cannot go on, and the stage writes nothing.
// A fake embedder stands in for the model; synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { minilmHealthOf } from "@/lib/health/minilm";
import { agreementOf, shadowNight, shadowSummary } from "@/lib/llm/minilm/shadow";
import { switchRefusal } from "@/lib/config/switchGuards";
import { cleanupTempDbs } from "../../db/helpers";
import { fakeEmbedder, headOf, lockOf, withAnnouncements } from "../../llm/minilm/helpers";
import { MIGRATION_OWNED, STEELMAN_OWN, at32World } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const D = "2030-01-03";
const OWN = new Set<string>([...STEELMAN_OWN, "minilm_shadow"]);
const ANN = [
  { source: "zz", ann_id: "a1", type: "Trading Halt", title: "Trading Halt" },
  { source: "zz", ann_id: "a2", type: null, title: "Quarterly update" },
  { source: "zz", ann_id: "a3", type: null, title: "Chalton update" },
];

/** Hash of every table outside the own-set, row by row. */
async function complement(db: Client): Promise<Record<string, string>> {
  const names = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows.map((r) => String(r.name));
  const out: Record<string, string> = {};
  for (const t of names) {
    if (OWN.has(t) || MIGRATION_OWNED.has(t)) continue;
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows
      .map((c) => String(c.name))
      .filter((c) => !(t === "source_register_history" && c === "changed_at"))
      .filter((c) => !(t === "cortex_night" && c === "runtime_ms"));
    const rs = await db.execute(
      `SELECT ${cols.join(", ")} FROM ${t} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    out[t] = createHash("sha256")
      .update(JSON.stringify(rs.rows.map((x) => cols.map((c) => String(x[c])))))
      .digest("hex");
  }
  return out;
}

const input = (enabled: boolean) => ({
  market: "AU",
  d: D,
  enabled,
  cap: 40,
  head: headOf(),
  lock: lockOf(),
  embedder: fakeEmbedder(),
  now: "2030-01-03T10:00:00.000Z",
});

describe("AT-80 MiniLM: shadow on versus off", () => {
  it("the complement is equal, the rows exist only when on, and the agreement is published", async () => {
    const off = await at32World();
    const on = await at32World();
    const before = await complement(on);
    expect(await complement(off)).toEqual(before);

    const rOff = await shadowNight(withAnnouncements(off, ANN), input(false));
    const rOn = await shadowNight(withAnnouncements(on, ANN), input(true));

    expect(rOff).toMatchObject({ status: "off", written: 0 });
    expect(rOn).toMatchObject({ status: "written", written: 3 });
    const n = async (db: Client) =>
      Number((await db.execute("SELECT COUNT(*) n FROM minilm_shadow")).rows[0]!.n);
    expect(await n(off)).toBe(0);
    expect(await n(on)).toBe(3);

    // the AT-32 complement proof: nothing outside the own-set moved, on or off
    expect(await complement(on)).toEqual(before);
    expect(await complement(off)).toEqual(before);

    // the agreement is published: in the run summary and on the System Health line
    expect(rOn.agreement).toEqual({ rows: 3, agree: 2, materialAgree: 2 });
    expect(await agreementOf(on, "AU", D)).toEqual(rOn.agreement);
    expect(shadowSummary("AU", D, rOn)).toBe(
      `minilm-shadow AU ${D}: written written=3 rows=3 agree=2 material_agree=2`,
    );
    expect(
      minilmHealthOf({ enabled: true, problem: null, latest: { d: D, agreement: rOn.agreement } })
        .line,
    ).toBe(
      "Small reader: on, agreed with the written rules on 2 of 3 announcements (67 %) on Thu 3 Jan",
    );
  });
});

describe("AT-80 MiniLM: nothing goes on by itself", () => {
  it("the committed head is untrained and the lock unpinned: the setting refuses and the stage would write nothing", async () => {
    const db = await at32World();
    expect(await switchRefusal(db, "minilm_enabled", "on")).toBe(
      "The local classifier has not been trained yet",
    );
    const r = await shadowNight(withAnnouncements(db, ANN), {
      ...input(true),
      head: headOf({ trained: false }),
    });
    expect(r).toMatchObject({ status: "not_ready", written: 0 });
    expect(r.agreement.rows).toBe(0);
  });
});
