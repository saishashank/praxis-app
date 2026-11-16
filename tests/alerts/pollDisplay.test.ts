// @vitest-environment node
// The quote-poll's display-only codes (ARN-021): the practice portfolios' holdings and the users'
// watchlists are polled for the site's delayed prices, held before watchlist; a failed read leaves the
// plan as it was. Synthetic ZZ data, injected fetch and clock, no network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import { runPickAlertPoll, type PollRunDeps } from "@/lib/alerts/pick/poll";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown, authCalls: 0 }));
vi.mock("@/lib/security/replay", () => ({
  TursoNonceStore: class {
    async claim() {
      return true;
    }
  },
}));
vi.mock("@/lib/db/client", () => ({
  mainDb: () => mem.main,
  authDb: () => {
    mem.authCalls += 1;
    return mem.auth;
  },
}));
import * as route from "@/app/api/internal/pick-alerts/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const SESSION = "2026-11-04";
const at = (hm: string) => new Date(`${SESSION}T${hm}:00.000+11:00`);
let db: Client;
let calls: string[];

const fetchStub: PollRunDeps["fetch"] = async (url) => {
  if (String(url).includes("%5EAXJO")) return { ok: false, status: 404, json: async () => ({}) };
  calls.push(url);
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price: 10.3,
        prevClose: 10,
        volume: 5000,
        timeS: Date.now() / 1000,
        symbol: `${code}.AX`,
      }),
  };
};
const deps = (over: Partial<PollRunDeps> = {}): PollRunDeps => ({
  db,
  now: () => at("10:45"),
  fetch: fetchStub,
  sleep: async () => {},
  recipients: async () => ["1"],
  ...over,
});
const codesCalled = () => calls.map((u) => /chart\/(\w+)\.AX/.exec(u)![1]);

async function seedPick(code: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', '2026-11-03', 'P1', 1, ?, 'F1', 'U1', 'F1.v1', ?, 'UNVALIDATED', 10000000, 10000000,
            '2026-11-12', 9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?, '2026-11-03T07:00:00.000Z')`,
    args: [code, `sig-${code}`, "a".repeat(64)],
  });
}
async function hold(code: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pick_portfolio_hold (market, profile, code, pos, strategy, pub_d, entry_d, entry_micro, qty, cost_micro)
          VALUES ('AU', 'balanced', ?, 1, 'F1', '2026-11-03', '2026-11-04', 10000000, 10, 100000000)`,
    args: [code],
  });
}
const authOf = (codes: string[]) =>
  ({
    execute: async () => ({ rows: codes.map((code) => ({ code })) }),
  }) as unknown as PollRunDeps["auth"];

beforeEach(async () => {
  db = await freshDb("main");
  calls = [];
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  await db.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
  );
  await seedPick("ZZ01");
});

describe("display-only codes in the poll", () => {
  it("a held code is polled after the armed pick; a held code already armed is not repeated", async () => {
    await hold("ZZH1");
    await hold("ZZ01");
    await runPickAlertPoll(deps());
    expect(codesCalled()).toEqual(["ZZ01", "ZZH1"]);
  });

  it("the users' watchlist codes follow the held ones (held first)", async () => {
    await hold("ZZH1");
    await runPickAlertPoll(deps({ auth: authOf(["ZZ01", "ZZW1", "ZZH1"]) }));
    expect(codesCalled()).toEqual(["ZZ01", "ZZH1", "ZZW1"]);
  });

  it("a failed watchlist read keeps the plan as it was", async () => {
    await hold("ZZH1");
    const broken = {
      execute: async () => {
        throw new Error("auth down");
      },
    } as unknown as PollRunDeps["auth"];
    const r = await runPickAlertPoll(deps({ auth: broken }));
    expect(r.status).toBe("ok");
    expect(codesCalled()).toEqual(["ZZ01"]);
  });
});

describe("POST /api/internal/pick-alerts wires the auth database", () => {
  it("a signed call hands the route's auth database to the poll", async () => {
    const SECRET = "7".repeat(64);
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    vi.stubEnv("PRAXIS_ENV", "staging");
    mem.main = db;
    mem.auth = authOf([]);
    mem.authCalls = 0;
    const raw = JSON.stringify({
      purpose: "pick-alerts",
      env: "staging",
      d: sydneyDate(Date.now()),
      slot: "quote-poll",
    });
    const nowS = Math.floor(Date.now() / 1000);
    const res = await route.POST(
      new Request("https://praxis-host.vercel.app/api/internal/pick-alerts", {
        method: "POST",
        body: raw,
        headers: sign(SECRET, raw, nowS, "ab".repeat(16)) as Record<string, string>,
      }),
    );
    expect(res.status).toBe(200);
    // the route hands the poll its own auth database (one read for the mailer, one for the poll)
    expect(mem.authCalls).toBeGreaterThanOrEqual(2);
  });
});
