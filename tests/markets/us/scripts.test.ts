// @vitest-environment node
// M20 US1 (D-1119, D-1180, D-1188): the US scripts. The recorded-day source reads a synthetic session folder written by
// the generator and produces exactly the files the day module takes; it refuses outside a recorded day. The fetch step
// without the EDGAR contact leaves EDGAR out with the fixed word and makes no EDGAR request; every other source is
// gated by its register row (pending rows are refused). The database step runs a night end to end through the CLI.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../../db/helpers";
import { run as recordedDay, readSession } from "../../../scripts/ingest/us/recorded_day.mjs";
import { run as runUs } from "../../../scripts/ingest/us/run.mjs";
import { fetchNight } from "../../../scripts/ingest/us/fetch.mjs";
import {
  buildUsFixtures,
  writeUsFixtures,
  SESSIONS,
  COMPANIES,
} from "../../../scripts/ingest/us/synthetic.mjs";
import { DAYS, MARKET, nightMs, sessionFiles, usDevDb } from "./usDev";

afterEach(cleanupTempDbs);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "praxis-us-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the synthetic generator", () => {
  it("is deterministic and says so: five sessions, fictional codes, source synthetic_fixture, a README", () => {
    const a = buildUsFixtures();
    const b = buildUsFixtures();
    expect(a.files).toEqual(b.files);
    expect(a.sessions).toEqual(SESSIONS);
    expect(COMPANIES.map((c: { code: string }) => c.code)).toEqual(["ZZA", "ZZB", "ZZC", "ZZD"]);
    expect(a.files["README.txt"]).toMatch(/^SYNTHETIC DATA/);
    const bars = JSON.parse(a.files[`${SESSIONS[0]}/bars.json`]!) as { source: string }[];
    expect(bars.every((r) => r.source === "synthetic_fixture")).toBe(true);
    // 5 sessions x (bars + 4 submissions + facts + finra + halts + 2 index) + form4 x4 + 13D x2 + suspensions x1 + README
    expect(Object.keys(a.files).length).toBe(1 + 5 * 10 + 4 + 2 + 1);
  });
});

describe("recorded_day.mjs", () => {
  it("refuses outside a recorded day", async () => {
    const lines: string[] = [];
    expect(
      await recordedDay(
        [
          "--fixtures",
          "x",
          "--market",
          "US",
          "--date",
          "2026-11-02",
          "--bars-output",
          "b",
          "--feeds-output",
          "f",
        ],
        {},
        { out: (s: string) => lines.push(s) },
      ),
    ).toBe(2);
    expect(lines[0]).toContain("recorded days only");
  });

  it("writes the same bars and feeds the day module takes", async () => {
    const root = tmp();
    writeUsFixtures(path.join(root, "recorded", MARKET));
    const out = tmp();
    const lines: string[] = [];
    const code = await recordedDay(
      [
        "--fixtures",
        root,
        "--market",
        MARKET,
        "--date",
        DAYS[1]!,
        "--bars-output",
        path.join(out, "bars.json"),
        "--feeds-output",
        path.join(out, "feeds.json"),
      ],
      { PRAXIS_ENV: "recorded" },
      { out: (s: string) => lines.push(s) },
    );
    expect(code).toBe(0);
    expect(lines[0]).toBe("us_recorded_day: ok bars=4 submissions=4 form4=1");
    const expected = sessionFiles(DAYS[1]!);
    expect(JSON.parse(readFileSync(path.join(out, "bars.json"), "utf8"))).toEqual(
      JSON.parse(expected.barsText),
    );
    expect(JSON.parse(readFileSync(path.join(out, "feeds.json"), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(expected.feeds)),
    );
    expect(readSession(path.join(root, "recorded", MARKET, DAYS[4]!)).feeds.suspensions).toContain(
      "ZZD",
    );
  });

  it("an unreadable session is exit 2 and prints no path", async () => {
    const lines: string[] = [];
    const code = await recordedDay(
      [
        "--fixtures",
        tmp(),
        "--market",
        MARKET,
        "--date",
        "2026-11-02",
        "--bars-output",
        "b",
        "--feeds-output",
        "f",
      ],
      { PRAXIS_ENV: "recorded" },
      { out: (s: string) => lines.push(s) },
    );
    expect(code).toBe(2);
    expect(lines.join("")).not.toMatch(/praxis-us-/);
  });
});

describe("fetch.mjs without the EDGAR contact", () => {
  it("leaves EDGAR and the SEC feed out with the fixed word and requests nothing from them; gated sources are refused", async () => {
    const db = await usDevDb();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      calls.push(String(input));
      return new Response("", { status: 404 });
    }) as typeof fetch;
    let t = 0;
    const lines: string[] = [];
    const { feeds, outcome } = await fetchNight({
      db,
      market: MARKET,
      env: {},
      request: { codes: ["ZZA"], end: DAYS[0]! },
      fetchImpl,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      out: (s: string) => lines.push(s),
    });
    expect(outcome.edgar).toBe("contact_missing");
    expect(outcome.suspensions).toBe("contact_missing");
    // FINRA and Nasdaq rows are `pending` in the register: refused by the gate, never requested
    expect(outcome.finra).toBe("refused:source_not_enabled");
    expect(outcome.halts).toBe("refused:source_not_enabled");
    expect(calls).toEqual([]);
    expect(feeds.submissions).toEqual([]);
    expect(lines[0]).toBe(
      "us_fetch: edgar=contact_missing suspensions=contact_missing finra=refused:source_not_enabled halts=refused:source_not_enabled",
    );
  });

  it("with a dummy contact and an enabled EDGAR row it asks the SEC hosts only, with the declared User-Agent", async () => {
    const db = await usDevDb();
    const calls: { url: string; ua: string }[] = [];
    const body: Record<string, string> = {
      "https://www.sec.gov/files/company_tickers.json": JSON.stringify({
        0: { cik_str: 9990001, ticker: "ZZA" },
      }),
      [`https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.${DAYS[0]!.replaceAll("-", "")}.idx`]: `8-K        Zeta Zero Alpha Software Inc    9990001   ${DAYS[0]!.replaceAll("-", "")}   edgar/data/9990001/0009990000-26-000010.txt\n`,
      "https://data.sec.gov/submissions/CIK0009990001.json": sessionFiles(DAYS[0]!).feeds
        .submissions
        ? JSON.stringify((sessionFiles(DAYS[0]!).feeds.submissions as { json: unknown }[])[0]!.json)
        : "{}",
    };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        ua: ((init?.headers ?? {}) as Record<string, string>)["user-agent"] ?? "",
      });
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return body[url] === undefined
        ? new Response("", { status: 404 })
        : new Response(body[url], { status: 200 });
    }) as typeof fetch;
    let t = 0;
    const { feeds, outcome } = await fetchNight({
      db,
      market: MARKET,
      env: { PRAXIS_EDGAR_CONTACT: "fixture-contact-not-a-real-value" },
      request: { codes: ["ZZA", "ZZB"], end: DAYS[0]! },
      fetchImpl,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
    });
    expect(outcome.edgar).toBe("ok:1");
    expect(feeds.submissions.map((s: { code: string }) => s.code)).toEqual(["ZZA"]);
    const sec = calls.filter((c) => !c.url.endsWith("/robots.txt") && /sec\.gov/.test(c.url));
    expect(sec.length).toBeGreaterThanOrEqual(3);
    expect(sec.every((c) => c.ua === "Praxis/1 (fixture-contact-not-a-real-value)")).toBe(true);
  });
});

describe("run.mjs end to end", () => {
  it("prepare writes the request, run writes the night through the CLI", async () => {
    const db = await usDevDb();
    const dir = tmp();
    const env = { TURSO_MAIN_URL: "file:unused" };
    const d = DAYS[1]!;
    const lines: string[] = [];
    const now = `${d}T23:30:00.000Z`;
    const open = () =>
      ({
        execute: (...a: Parameters<typeof db.execute>) => db.execute(...a),
        batch: (...a: Parameters<typeof db.batch>) => db.batch(...a),
        close: () => undefined,
      }) as unknown as typeof db;
    const sim = { ...env, PRAXIS_ENV: "recorded" };
    expect(
      await runUs(
        ["prepare", "--market", MARKET, "--request", path.join(dir, "r.json"), "--now", now],
        sim,
        { openDb: open, out: (s: string) => lines.push(s) },
      ),
    ).toBe(0);
    expect(lines[0]).toBe("us-batch1 prepare: fetch dates=1 codes=4 excluded=0");
    const req = JSON.parse(readFileSync(path.join(dir, "r.json"), "utf8"));
    expect(req).toMatchObject({ suffix: "", currency: "USD", end: d });
    const f = sessionFiles(d);
    writeFileSync(path.join(dir, "bars.json"), f.barsText);
    writeFileSync(path.join(dir, "feeds.json"), JSON.stringify(f.feeds));
    expect(
      await runUs(
        [
          "run",
          "--market",
          MARKET,
          "--bars",
          path.join(dir, "bars.json"),
          "--feeds",
          path.join(dir, "feeds.json"),
          "--now",
          now,
        ],
        sim,
        { openDb: open, out: (s: string) => lines.push(s) },
      ),
    ).toBe(0);
    expect(lines[1]).toMatch(
      /^us-batch1: ok target=2026-11-03 dates=1 read=\d+ written=\d+ bars=4 rejected=0$/,
    );
    const n = await db.execute("SELECT COUNT(*) AS n FROM price_bar WHERE market = 'US'");
    expect(Number(n.rows[0]!.n)).toBe(4);
    expect(nightMs(d)).toBeGreaterThan(0);
  });
});
