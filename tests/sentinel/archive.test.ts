// @vitest-environment node
// The announcement archive by forward accumulation (CR-MOV-A7; D-749): timing classes, the halt kind,
// the known_at stamp, idempotence and the ingest hook. Synthetic ZZ data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPublication, DEFAULT_HOURS } from "@/lib/sentinel/archive";
import { ingestFeed } from "@/lib/sentinel/ingest";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

// Wed 2030-03-06 in Melbourne (AEDT, UTC+11): 10:00 local is 2030-03-05T23:00Z.
const WED = "2030-03-06";
const local = (hhmm: string, d = WED): string => {
  const [h, m] = hhmm.split(":").map(Number);
  const utc = Date.parse(`${d}T00:00:00.000Z`) + ((h! - 11) * 60 + m!) * 60_000;
  return new Date(utc).toISOString();
};

describe("classifyPublication", () => {
  it("before 10:00 is pre_open, during the session intraday, after the close post_close", () => {
    expect(classifyPublication(local("08:45"), DEFAULT_HOURS, [])).toEqual({
      timing: "pre_open",
      sessionD: WED,
    });
    expect(classifyPublication(local("10:00"), DEFAULT_HOURS, []).timing).toBe("intraday");
    expect(classifyPublication(local("16:05"), DEFAULT_HOURS, []).timing).toBe("intraday"); // the closing auction
    expect(classifyPublication(local("16:30"), DEFAULT_HOURS, [])).toEqual({
      timing: "post_close",
      sessionD: "2030-03-07",
    });
  });

  it("a weekend or holiday item is pre_open of the next session", () => {
    expect(classifyPublication(local("12:00", "2030-03-09"), DEFAULT_HOURS, [])).toEqual({
      timing: "pre_open",
      sessionD: "2030-03-11",
    });
    const holiday = [{ d: WED, kind: "holiday" as const, close_time: null }];
    expect(classifyPublication(local("12:00"), DEFAULT_HOURS, holiday)).toEqual({
      timing: "pre_open",
      sessionD: "2030-03-07",
    });
  });
});

const feed = (list: { id: string; code: string; time: string; title: string; type?: string }[]) =>
  JSON.stringify({
    data: list.map((o) => ({
      type: "Progress Report",
      price_sensitive: true,
      url: "https://example.test/doc.pdf",
      ...o,
    })),
  });

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

describe("ingestFeed writes the archive", () => {
  const NOW = `${WED}T03:10:00.000Z`; // 14:10 Melbourne
  const go = (body: string, sha: string, now = NOW) =>
    ingestFeed({ db, feed: body, sha, now, today: WED, maxItems: 40 });

  it("every ingested item lands once with its timing, halt kind and known_at = the ingest instant", async () => {
    const body = feed([
      { id: "1", code: "ZZAA", time: local("08:30"), title: "Trading Halt", type: "Trading Halt" },
      {
        id: "2",
        code: "ZZAA",
        time: local("13:00"),
        title: "Half year results",
        type: "Half Yearly Report",
      },
      { id: "3", code: "ZZBB", time: local("09:15"), title: "Reinstatement to Official Quotation" },
    ]);
    const res = await go(body, "a".repeat(64));
    expect(res.ok).toBe(true);
    const rows = (
      await db.execute(
        "SELECT title, session_d, timing, halt_kind, price_sensitive, known_at FROM announcement_archive ORDER BY title",
      )
    ).rows.map((r) => ({ ...r }));
    expect(rows).toEqual([
      {
        title: "Half year results",
        session_d: WED,
        timing: "intraday",
        halt_kind: null,
        price_sensitive: 1,
        known_at: NOW,
      },
      {
        title: "Reinstatement to Official Quotation",
        session_d: WED,
        timing: "pre_open",
        halt_kind: "reinstatement",
        price_sensitive: 1,
        known_at: NOW,
      },
      {
        title: "Trading Halt",
        session_d: WED,
        timing: "pre_open",
        halt_kind: "halt",
        price_sensitive: 1,
        known_at: NOW,
      },
    ]);
  });

  it("a repeated body adds nothing and keeps the first known_at (point-in-time)", async () => {
    const body = feed([{ id: "1", code: "ZZAA", time: local("13:00"), title: "Update" }]);
    await go(body, "b".repeat(64));
    await go(body, "c".repeat(64), `${WED}T05:00:00.000Z`);
    const r = await db.execute("SELECT known_at FROM announcement_archive");
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0]!.known_at)).toBe(NOW);
  });

  it("outlives the pruned announcement table: the archive has no delete path", async () => {
    await go(
      feed([{ id: "1", code: "ZZAA", time: local("13:00"), title: "Update" }]),
      "d".repeat(64),
    );
    await expect(db.execute("DELETE FROM announcement_archive")).rejects.toThrow(/append-only/);
  });

  it("an archive fault never fails the ingest", async () => {
    await db.execute("DROP TABLE announcement_archive");
    const res = await go(
      feed([{ id: "1", code: "ZZAA", time: local("13:00"), title: "Update" }]),
      "e".repeat(64),
    );
    expect(res).toMatchObject({ ok: true, new: 1 });
  });
});
