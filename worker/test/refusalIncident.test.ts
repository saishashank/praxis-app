// M20 A2 (D-1123): the Worker pipeline reports a refused write like the app and the scripts do: ONE S2
// market_not_enabled incident per market-day, best effort, before the fixed-word error is thrown.
import { beforeEach, describe, expect, it } from "vitest";
import { MarketNotEnabledError, pipeline, resetRefusalReports } from "../src/db";

const ENV = { TURSO_MAIN_URL: "libsql://example.turso.io", TURSO_MAIN_TOKEN: "t" };
beforeEach(resetRefusalReports);

type Sent = { sql: string; args: { type: string; value?: string }[] };

/** A fetch whose first statement of the first call is refused; later calls answer the lookups and the insert. */
function world(failInsert = false) {
  const sent: Sent[][] = [];
  const f = (async (_u: string, init: { body: string }) => {
    const reqs = (JSON.parse(init.body) as { requests: { type: string; stmt?: Sent }[] }).requests;
    const stmts = reqs.filter((r) => r.type === "execute").map((r) => r.stmt!);
    sent.push(stmts);
    if (sent.length === 1)
      return Response.json({
        results: [
          { type: "error", error: { message: "SQLite error: MarketNotEnabled price_bar" } },
          { type: "ok" },
        ],
      });
    if (stmts[0]!.sql.startsWith("SELECT code, enabled FROM market"))
      return Response.json({
        results: [
          {
            type: "ok",
            response: {
              result: {
                rows: [
                  [
                    { type: "text", value: "AU" },
                    { type: "integer", value: "1" },
                  ],
                  [
                    { type: "text", value: "IN" },
                    { type: "integer", value: "0" },
                  ],
                ],
              },
            },
          },
          { type: "ok" },
        ],
      });
    if (failInsert) return new Response("nope", { status: 500 });
    return Response.json({
      results: [{ type: "ok", response: { result: { rows: [] } } }, { type: "ok" }],
    });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const write = {
  sql: "INSERT INTO price_bar (market, code) VALUES (?, ?)",
  args: ["IN", "TCS"] as (string | number | null)[],
};

describe("the Worker refusal reporter", () => {
  it("throws the fixed word and sends one guarded S2 incident insert naming the market and the table", async () => {
    const { f, sent } = world();
    await expect(pipeline(ENV, [write], f)).rejects.toBeInstanceOf(MarketNotEnabledError);
    expect(sent).toHaveLength(3); // the refused call, the market lookup, the incident
    const ins = sent[2]![0]!;
    expect(ins.sql).toContain("INSERT INTO incident");
    expect(ins.sql).toContain("WHERE NOT EXISTS");
    const values = ins.args.map((a) => a.value);
    expect(values).toContain("S2");
    expect(values).toContain("market_not_enabled");
    expect(JSON.parse(values[3]!)).toEqual({ market: "IN", table: "price_bar" });
  });

  it("a second refusal the same day sends no second incident", async () => {
    const { f, sent } = world();
    await expect(pipeline(ENV, [write], f)).rejects.toBeInstanceOf(MarketNotEnabledError);
    const first = sent.length;
    const g = (async (u: string, init: { body: string }) => {
      sent.push([]);
      return Response.json({
        results: [
          { type: "error", error: { message: "MarketNotEnabled price_bar" } },
          { type: "ok" },
        ],
      });
    }) as unknown as typeof fetch;
    await expect(pipeline(ENV, [write], g)).rejects.toBeInstanceOf(MarketNotEnabledError);
    // the refused call and its market lookup (which the same answer refuses too); no incident insert
    expect(sent.length - first).toBe(2);
  });

  it("a failing incident write never changes the outcome", async () => {
    const { f } = world(true);
    await expect(pipeline(ENV, [write], f)).rejects.toBeInstanceOf(MarketNotEnabledError);
  });
});
