// @vitest-environment node
// Committee trial page and loader (M22 C2; UXN-289, UXN-290; D-1423): the empty state, status, progress against the frozen
// minimums, the pre-registration record, the interim figure labelled "interim, not a result", the final verdict, the night
// tables with the debate text, the models, the skipped signals and the card link, paging by day with no OFFSET, and masking
// (the Owner sees codes and exact days; an Editor and a Viewer see neither a code nor the trial id). Synthetic ZZ data.
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trialNight } from "@/lib/committee/trial";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser, ENV } from "../auth/helpers";
import { build, dayOf, grid, NOW, switchOn, TRIAL, type Spec } from "./trialWorld";

const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("@/auth", () => ({ handlers: { GET: vi.fn(), POST: vi.fn() }, auth: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("NEXT_FORBIDDEN");
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import CommitteeTrialPage from "@/app/(app)/strategies/experiments/committee/page";
import { loadCommitteeTrial, NIGHTS_SHOWN } from "@/lib/ui/loaders/committee";

afterEach(cleanupTempDbs);
process.env.PII_HASH_KEY = ENV.PII_HASH_KEY;

const text = (html: string) =>
  html
    .replace(/<script.*?<\/script>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

type World = { main: Client; auth: Client; owner: number; editor: number; viewer: number };

async function world(
  specs: readonly Spec[],
  over: Parameters<typeof build>[1] = {},
): Promise<World> {
  const main = await build(specs, over);
  const auth = await freshDb("auth");
  return {
    main,
    auth,
    owner: await addUser(auth, { email: "owner@example.test", role: "owner" }),
    editor: await addUser(auth, { email: "editor@example.test", role: "editor" }),
    viewer: await addUser(auth, { email: "viewer@example.test", role: "viewer" }),
  };
}
const as = (w: World, who: "owner" | "editor" | "viewer") => {
  mem.main = w.main;
  mem.auth = w.auth;
  mem.user = { id: w[who], email: `${who}@example.test`, name: null, role: who };
};
const deps = (w: World, who: "owner" | "editor" | "viewer") => ({
  mainDb: w.main,
  authDb: w.auth,
  user: { id: w[who], role: who },
  now: new Date(NOW),
});
const render = async (sp: Record<string, string> = {}) =>
  text(renderToStaticMarkup(await CommitteeTrialPage({ searchParams: Promise.resolve(sp) })));

const SIGNAL = (night: number, k: number) => `ZZ-${TRIAL}-${dayOf(night)}-${k}`;

async function debate(db: Client, night: number, k: number, textOf: string): Promise<void> {
  for (const stage of ["bull", "bear", "risk", "judge"]) {
    await db.execute({
      sql: `INSERT INTO committee_call (id, market, d, signal_id, stage, prompt_sha, pack_id, provider, model_id,
              model_version, params_json, raw_response, parsed_json, created_at, expires_d)
            VALUES (?, 'AU', ?, ?, ?, 'h', 'p', 'zz', 'zz-model', 'v1', '{}', 'raw', ?, ?, '2999-01-01')`,
      args: [
        `call-${night}-${k}-${stage}`,
        dayOf(night),
        SIGNAL(night, k),
        stage,
        JSON.stringify(
          stage === "judge"
            ? { rating: "approve", reasons: [{ text: textOf, citations: ["E01"] }] }
            : [{ text: `${stage}: ${textOf}`, citations: ["E01"] }],
        ),
        NOW,
      ],
    });
  }
}

async function card(db: Client, night: number, k: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO decision_card (id, signal_id, execution_id, taken, not_taken_reason, order_id, card_json, card_sha, schema_version, decided_at)
          VALUES (?, ?, 'x', 0, 'rank', NULL, '{}', ?, 1, ?)`,
    args: [`card-${night}-${k}`, SIGNAL(night, k), "a".repeat(64), NOW],
  });
}

describe("no trial yet", () => {
  it("says so, for every role, and shows no table", async () => {
    const w = await world([], { prereg: false });
    for (const who of ["owner", "editor", "viewer"] as const) {
      as(w, who);
      const t = await render();
      expect(t).toContain("Committee trial");
      expect(t).toContain("No trial yet. The Committee is off.");
      expect(t).not.toContain("Night by night");
    }
    await switchOn(w.main);
    as(w, "owner");
    expect(await render()).toContain("its trial starts tonight");
    const m = await loadCommitteeTrial(deps(w, "owner"));
    expect(m).toMatchObject({ state: "empty", data: { status: "none", nights: [] } });
  });
});

describe("a running trial", () => {
  const specs: Spec[] = [
    ...grid(3, (n, l) => (l === "approve" ? 900 + n : l === "reject" ? 100 : 400)),
    { night: 3, rating: "skipped_models", net: null },
    { night: 4, rating: "skipped_budget", net: null },
  ];

  it("shows status, progress against the minimums, the pre-registration and the interim figure labelled as such", async () => {
    const w = await world(specs, {
      frozen: { trial_sessions: 6, min_settled: 12, cost_threshold_ppm: 100 },
    });
    await switchOn(w.main);
    await trialNight(w.main, { market: "AU", d: dayOf(4), today: dayOf(4), now: NOW });
    as(w, "owner");
    const t = await render();
    expect(t).toContain("The trial is running");
    expect(t).toContain("Nights so far: 5 of 6");
    expect(t).toContain("Settled picks: 9 of 12 needed");
    expect(t).toContain("Interim, not a result");
    expect(t).toContain("Approved picks minus rejected picks, on average: 0.08 percentage points");
    expect(t).toContain("Written down before it started");
    expect(t).toContain("It has not changed");
    expect(t).toContain("Smallest settled sample: 12");
    expect(t).toContain("2 nights with no opinion at all");
    expect(t).not.toContain("Result on");
    const m = await loadCommitteeTrial(deps(w, "owner"));
    expect(m.data.figure).toMatchObject({ interim: true, note: "interim, not a result" });
    expect(m.data.prereg?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists each night with the rating, the reasons, the debate, the models, skipped signals and the card link", async () => {
    const w = await world(specs, { frozen: { trial_sessions: 6, min_settled: 12 } });
    await debate(w.main, 0, 1, "a plain point about the evidence");
    await card(w.main, 0, 1);
    as(w, "owner");
    const t = await render();
    expect(t).toContain("ZZ0X1: Approve");
    expect(t).toContain("ZZ0X2: Neutral");
    expect(t).toContain("ZZ0X3: Reject");
    expect(t).toContain("The debate");
    expect(t).toContain("The case for");
    expect(t).toContain("bull: a plain point about the evidence");
    expect(t).toContain("Models: for zz-bull, against zz-bear, risks zz-bull, judge zz-judge");
    expect(t).toContain("ZZ3X1: Skipped: no model available");
    expect(t).toContain("ZZ4X1: Skipped: out of budget");
    expect(t).toContain("Nothing was rated this night.");
    const html = renderToStaticMarkup(
      await CommitteeTrialPage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('href="/cards/card-0-1"');
    expect(html).toContain("Evidence it was given");
  });

  it("names no internal code, no table and no model role", async () => {
    const w = await world(specs, { frozen: { trial_sessions: 6, min_settled: 12 } });
    await switchOn(w.main);
    await trialNight(w.main, { market: "AU", d: dayOf(4), today: dayOf(4), now: NOW });
    as(w, "owner");
    const t = await render();
    expect(t).not.toMatch(
      /\b(R[1-7]|VAL-\d+|ARN-\d+|UXN-\d+|AGT-\d+|D-\d{3,4}|committee_[a-z_]+|holdout)\b/,
    );
  });
});

describe("a finished trial", () => {
  it("shows the verdict, who stopped the Committee and no interim label on the final figure", async () => {
    const w = await world(
      grid(8, (n, l) => (l === "approve" ? 1000 + (n % 3) : l === "reject" ? 100 : 500)),
      {
        frozen: { trial_sessions: 6, min_settled: 12, cost_threshold_ppm: 100 },
      },
    );
    await switchOn(w.main);
    await trialNight(w.main, { market: "AU", d: dayOf(8), today: dayOf(8), now: NOW });
    as(w, "owner");
    const t = await render();
    expect(t).toContain("The trial has ended: passed.");
    expect(t).toContain("Passed");
    expect(t).toContain("The Committee switched itself off");
    expect(t).toContain("The figure behind the result");
    expect(t).not.toContain("Interim, not a result");
  });

  it("an invalid trial says why", async () => {
    const w = await world(grid(2, () => 100));
    await switchOn(w.main);
    await w.main.execute({
      sql: "INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES (?, 2, 'AU', '{}', ?, ?)",
      args: [TRIAL, "b".repeat(64), "2026-02-01T00:00:00.000Z"],
    });
    await trialNight(w.main, { market: "AU", d: dayOf(2), today: dayOf(2), now: NOW });
    as(w, "owner");
    const t = await render();
    expect(t).toContain("Invalid: stopped");
    expect(t).toContain("It was changed afterwards, so the trial is not valid");
    expect(t).toContain("The pre-registration was changed after the trial started.");
  });
});

describe("masking", () => {
  it("an Editor and a Viewer see no code, no trial id, no exact day and an opaque card link; the Owner sees them", async () => {
    const w = await world(grid(2, (n, l) => (l === "approve" ? 900 : l === "reject" ? 100 : 400)));
    await debate(w.main, 0, 1, "ZZ0X1 stands out against its peers");
    await card(w.main, 0, 1);
    const owner = JSON.stringify(await loadCommitteeTrial(deps(w, "owner")));
    expect(owner).toContain("ZZ0X1");
    expect(owner).toContain(TRIAL);
    expect(owner).toContain("/cards/card-0-1");
    for (const who of ["editor", "viewer"] as const) {
      const m = await loadCommitteeTrial(deps(w, who));
      const json = JSON.stringify(m);
      expect(m.masked).toBe(true);
      expect(json).not.toContain("ZZ0X1");
      expect(json).not.toContain(TRIAL);
      expect(json).not.toContain(dayOf(0));
      expect(json).not.toContain("/cards/card-0-1");
      expect(json).toContain("/cards/ck%3A");
      expect(m.data.prereg?.trialId).toBeNull();
      as(w, who);
      const t = await render();
      expect(t).not.toContain("ZZ0X1");
      expect(t).toContain("Night by night");
      expect(t).toContain("Approve");
    }
  });
});

describe("paging", () => {
  it("shows the newest 20 nights and a link to earlier ones; the next page starts below it; a masked viewer gets no cursor", async () => {
    const w = await world(grid(25, () => 100));
    const first = await loadCommitteeTrial(deps(w, "owner"));
    expect(first.data.nights).toHaveLength(NIGHTS_SHOWN);
    expect(first.data.nights[0]!.d).toBe(dayOf(24));
    expect(first.data.earlier).toBe(dayOf(5));
    const second = await loadCommitteeTrial(deps(w, "owner"), { before: first.data.earlier });
    expect(second.data.nights.map((n) => n.d)).toEqual([
      dayOf(4),
      dayOf(3),
      dayOf(2),
      dayOf(1),
      dayOf(0),
    ]);
    expect(second.data.earlier).toBeNull();
    as(w, "owner");
    expect(
      renderToStaticMarkup(await CommitteeTrialPage({ searchParams: Promise.resolve({}) })),
    ).toContain(`href="/strategies/experiments/committee?before=${dayOf(5)}"`);
    const masked = await loadCommitteeTrial(deps(w, "viewer"));
    expect(masked.data.earlier).toBeNull();
    expect(masked.data.nights.every((n) => n.d === null)).toBe(true);
  });

  it("has no OFFSET in the loader or the page", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    for (const f of [
      "src/lib/ui/loaders/committee.ts",
      "src/app/(app)/strategies/experiments/committee/page.tsx",
    ])
      expect(
        fs.readFileSync(path.join(root, f), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""),
      ).not.toMatch(/\bOFFSET\b/i);
  });
});
