// @vitest-environment node
// The experts job entry (M22 E2; KB-082, KB-083, D-1429): phases in order, each guarded; discovery only on Sundays
// (Melbourne); counts only in the output; a missing database is a calm "degraded". Fixture fetch, no network, no model.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { expertsMain } from "@/lib/experts/poll/cli";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld } from "../uiWorld";
import {
  licence,
  noSleep,
  recordingFetch,
  rowsOf,
  rss,
  ROBOTS_ALLOW,
  SITE,
  SITE_FEED,
  type Reply,
} from "./helpers";

afterAll(cleanupTempDbs);

let main: Client;
beforeEach(async () => {
  main = (await zzWorld()).main;
});

const ENV = { TURSO_MAIN_URL: "file:zz", TURSO_MAIN_TOKEN: "tok-zz" };
const table = (): Record<string, Reply> => ({
  [`${SITE(1)}/robots.txt`]: { status: 200, text: ROBOTS_ALLOW },
  [SITE_FEED(1)]: {
    status: 200,
    text: rss([{ title: "One", link: "https://zz1.example.test/c/1" }]),
  },
});
function run(argv: string[], over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const f = recordingFetch(table());
  const code = expertsMain(argv, ENV, {
    openDb: () =>
      ({
        execute: (s: never) => main.execute(s),
        batch: (s: never, m: never) => main.batch(s, m),
        close: () => undefined,
      }) as unknown as Client,
    nowMs: () => Date.parse("2030-03-05T10:00:00.000Z"),
    out: (l) => out.push(l),
    fetch: f.fetch,
    resolve: async () => ["93.184.216.34"],
    sleep: noSleep,
    ...over,
  });
  return { code, out, asked: f.asked };
}

describe("expertsMain", () => {
  it("a missing database is a calm degraded line and exit 0; an unknown phase is a usage error", async () => {
    const out: string[] = [];
    expect(await expertsMain([], {}, { out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(["experts: degraded (database not configured)"]);
    const bad = run(["--phase", "everything"]);
    expect(await bad.code).toBe(2);
    expect(bad.out).toEqual(["experts: refused (unknown phase)"]);
  });

  it("`all` runs the licence check, the poll and the extraction, in that order, and prints counts only", async () => {
    await licence(main, "X-ZZ1", SITE(1));
    const r = run(["--date", "2030-03-05"]); // a Tuesday: no discovery
    expect(await r.code).toBe(0);
    expect(r.out.map((l) => l.split(":")[0])).toEqual([
      "experts licence 2030-03-05",
      "experts poll 2030-03-05",
      "experts extract 2030-03-05",
    ]);
    expect(r.out[1]).toContain("new=1");
    expect(r.out[2]).toBe("experts extract 2030-03-05: no model switched on, items wait");
    for (const l of r.out) expect(l).not.toMatch(/example\.test|ZZ|https?:/);
    expect(
      Number(
        (
          await rowsOf(
            main,
            "SELECT COUNT(*) AS n FROM expert_poll_run WHERE kind IN ('licence','poll')",
          )
        )[0]!.n,
      ),
    ).toBe(2);
  });

  it("discovery runs on a Sunday only, or when asked for by name", async () => {
    const sunday = run(["--date", "2030-03-10"]);
    await sunday.code;
    expect(sunday.out.some((l) => l.startsWith("experts discovery 2030-03-10"))).toBe(true);
    const named = run(["--phase", "discovery", "--date", "2030-03-05"]);
    await named.code;
    expect(named.out).toHaveLength(1);
    expect(named.out[0]).toMatch(/^experts discovery 2030-03-05: considered=0 added=0 known=0$/);
  });

  it("the monthly licence check runs once a month and a second run the same day does nothing twice", async () => {
    const a = run(["--phase", "licence", "--date", "2030-03-05"]);
    await a.code;
    expect(a.out[0]).toMatch(/checked=/);
    const b = run(["--phase", "licence", "--date", "2030-03-20"]);
    await b.code;
    expect(b.out[0]).toBe("experts licence 2030-03-20: already done this month");
  });

  it("a phase that throws is one failed line, the other phases still run, and the exit code is 1", async () => {
    const r = run(["--date", "2030-03-05"], {
      llm: async () => {
        throw new TypeError("boom");
      },
    });
    expect(await r.code).toBe(1);
    expect(r.out.some((l) => l.startsWith("experts poll"))).toBe(true);
    expect(r.out.at(-1)).toBe("experts extract 2030-03-05: failed (TypeError)");
  });

  it("the date comes from the Melbourne day when none is given", async () => {
    const r = run(["--phase", "poll"], { nowMs: () => Date.parse("2030-03-05T14:30:00.000Z") }); // 01:30 on the 6th in Melbourne
    await r.code;
    expect(r.out[0]).toMatch(/^experts poll 2030-03-06:/);
  });
});
