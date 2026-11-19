// @vitest-environment node
// The licence check run and its monthly mode (M22 E1; KB-083, D-1429, D-1430, AT-79 "the monthly job records
// statuses"): fetch fixtures only, the ZZ expert seed in a fresh database.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { PLATFORM_SITES } from "@/lib/experts/licence/engine.mjs";
import { runLicenceCheck, runMonthlyLicence } from "@/lib/experts/licence/check";
import { appendLicence, latestLicence } from "@/lib/experts/licence/store";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld } from "../uiWorld";
import {
  fixtureFetch,
  noSleep,
  ROBOTS_ALLOW,
  ROBOTS_DENY,
  TERMS_FORBID,
  TERMS_PERMIT,
  type Reply,
} from "./helpers";

afterAll(cleanupTempDbs);

let main: Client;
beforeEach(async () => {
  main = (await zzWorld()).main;
});

const YT = PLATFORM_SITES.youtube!.origin;
const Z = (n: number) => `https://zz${n}.example.test`;
const at = (iso: string) => () => new Date(iso);
const status = async (id: string, k: string) =>
  (await latestLicence(main, { expertId: id, sourceKey: k }))?.status;

// ZZ1..ZZ4 are tracked with feeds (ZZ5 is a reference author, ZZ6 is retired); ZZ2 and ZZ4 have a YouTube handle.
const table = (): Record<string, Reply> => ({
  [`${YT}/robots.txt`]: { status: 200, text: ROBOTS_ALLOW },
  [`${YT}/t/terms`]: { status: 200, text: TERMS_PERMIT },
  [`${Z(1)}/robots.txt`]: { status: 200, text: ROBOTS_ALLOW },
  [`${Z(2)}/robots.txt`]: { status: 200, text: ROBOTS_DENY },
  [`${Z(3)}/robots.txt`]: { status: 200, text: ROBOTS_ALLOW },
  [`${Z(3)}/terms`]: { status: 200, text: TERMS_FORBID },
  [`${Z(4)}/robots.txt`]: { status: 503 },
});

describe("runLicenceCheck", () => {
  it("appends one row per fetchable source with the status of D-1430", async () => {
    const f = fixtureFetch(table());
    const rep = await runLicenceCheck(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-03-01T00:00:00.000Z"),
    });
    expect(await status("X-ZZ1", Z(1))).toBe("enabled"); // allowed, terms silent: titles and links only
    expect((await latestLicence(main, { expertId: "X-ZZ1", sourceKey: Z(1) }))?.note).toMatch(
      /titles and links only/,
    );
    expect(await status("X-ZZ2", Z(2))).toBe("no"); // robots disallows
    expect(await status("X-ZZ3", Z(3))).toBe("no"); // terms forbid
    expect(await status("X-ZZ4", Z(4))).toBe("unchecked"); // unreachable, nothing before
    expect(await status("X-ZZ2", "youtube:zz-handle-2")).toBe("enabled");
    expect(
      (await latestLicence(main, { expertId: "X-ZZ2", sourceKey: "youtube:zz-handle-2" }))
        ?.summarisation,
    ).toBe("yes");
    expect(rep).toMatchObject({ unreachable: 1, no: 2, notFetched: 0, capped: 0 });
    expect(rep.checked).toBe(rep.enabled + rep.no + rep.unreachable + rep.acceptedRisk);
    const rows = await main.execute("SELECT actor FROM expert_source_licence");
    expect(new Set(rows.rows.map((r) => r.actor))).toEqual(new Set(["job"]));
  });

  it("a reference author and a retired expert are not checked", async () => {
    const f = fixtureFetch(table());
    await runLicenceCheck(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-06-01T00:00:00.000Z"),
    });
    expect(f.asked.some((u) => u.startsWith(Z(5)) || u.startsWith(Z(6)))).toBe(false);
    const r = await main.execute("SELECT DISTINCT expert_id FROM expert_source_licence ORDER BY 1");
    expect(r.rows.map((x) => x.expert_id)).toEqual(["X-ZZ1", "X-ZZ2", "X-ZZ3", "X-ZZ4"]);
  });

  it("a shared origin is read once for all the experts that use it", async () => {
    const f = fixtureFetch(table());
    await runLicenceCheck(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-06-01T00:00:00.000Z"),
    });
    expect(f.asked.filter((u) => u === `${YT}/robots.txt`)).toHaveLength(1);
    expect(f.asked.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(5);
  });

  it("unreachable keeps the status that was there", async () => {
    await appendLicence(main, {
      expertId: "X-ZZ4",
      sourceKey: Z(4),
      checkedAt: "2030-01-01T00:00:00.000Z",
      termsUrl: null,
      robots: "allows",
      summarisation: "yes",
      status: "enabled",
      actor: "job",
      note: null,
    });
    const f = fixtureFetch(table());
    await runLicenceCheck(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-06-01T00:00:00.000Z"),
    });
    const l = await latestLicence(main, { expertId: "X-ZZ4", sourceKey: Z(4) });
    expect(l).toMatchObject({ status: "enabled", robots: "unreachable" });
  });

  it("an accepted risk survives a check that finds silent terms, but a robots disallowance still wins", async () => {
    for (const k of [Z(1), Z(2)])
      await appendLicence(main, {
        expertId: k === Z(1) ? "X-ZZ1" : "X-ZZ2",
        sourceKey: k,
        checkedAt: "2030-01-01T00:00:00.000Z",
        termsUrl: null,
        robots: "allows",
        summarisation: "unknown",
        status: "owner-accepted-risk",
        actor: "owner",
        note: null,
      });
    const f = fixtureFetch(table());
    await runLicenceCheck(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-06-01T00:00:00.000Z"),
    });
    expect(await status("X-ZZ1", Z(1))).toBe("owner-accepted-risk");
    expect(await status("X-ZZ2", Z(2))).toBe("no");
  });

  it("never fetches a manual-only platform or a source with no feed address", async () => {
    await main.execute({
      sql: "INSERT INTO expert (id, name, platforms_json, handles_json, home_urls_json, markets_json, focus_json, status, tier, created_at, updated_at) VALUES ('X-ZZM','ZZ Manual','[]',?, '[]','[\"AU\"]','[]','tracked','core','2030-01-01','2030-01-01')",
      args: [JSON.stringify({ x: "zzm", instagram: "zzm", substack: "zzm" })],
    });
    const f = fixtureFetch(table());
    const rep = await runLicenceCheck(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-06-01T00:00:00.000Z"),
    });
    expect(rep.notFetched).toBe(3);
    const r = await main.execute("SELECT 1 FROM expert_source_licence WHERE expert_id = 'X-ZZM'");
    expect(r.rows).toHaveLength(0);
  });

  it("stops at the request cap and says how many sources were left", async () => {
    const f = fixtureFetch(table());
    const rep = await runLicenceCheck(main, { fetch: f.fetch, sleep: noSleep, maxRequests: 3 });
    expect(rep.requests).toBeLessThanOrEqual(3);
    expect(rep.capped).toBeGreaterThan(0);
    expect(f.asked.length).toBeLessThanOrEqual(3);
  });
});

describe("runMonthlyLicence (the monthly mode of the experts job)", () => {
  it("runs once a month, records the counts, and the next call in the month does nothing", async () => {
    const f = fixtureFetch(table());
    const first = await runMonthlyLicence(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-03-02T01:00:00.000Z"),
    });
    expect(first?.checked).toBeGreaterThan(0);
    const run = await main.execute(
      "SELECT d, counts_json FROM expert_poll_run WHERE kind = 'licence'",
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]!.d).toBe("2030-03-02");
    expect(JSON.parse(String(run.rows[0]!.counts_json)).checked).toBe(first!.checked);
    const before = f.asked.length;
    expect(
      await runMonthlyLicence(main, {
        fetch: f.fetch,
        sleep: noSleep,
        now: at("2030-03-20T01:00:00.000Z"),
      }),
    ).toBeNull();
    expect(f.asked.length).toBe(before);
    const next = await runMonthlyLicence(main, {
      fetch: f.fetch,
      sleep: noSleep,
      now: at("2030-04-02T01:00:00.000Z"),
    });
    expect(next).not.toBeNull();
  });
});
