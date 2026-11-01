// @vitest-environment node
// Expert pages (M13-lite WP6; UXN-292..295, AT-41 (a), D-511, D-521, D-529, D-532, D-599): the directory order
// is by evidence and never by audience, the detail page hides red-flag text from a Viewer, the claims queue
// is closed to a Viewer (403, audited) and open to an Editor, masking hides codes and names, the techniques
// page says why a cluster has no result. Synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertClaim } from "@/lib/experts/store";
import { auditRows, ENV } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addRun, importSeed, usersIn, zzWorld, type World } from "../experts/uiWorld";
import { f1Fit } from "../experts/zzScreen";
import { EDITOR, emptyDbs, leaks, NOW, OWNER, seedPopulated, VIEWER } from "../loaders/seed";

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("NEXT_FORBIDDEN");
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import ExpertsPage from "@/app/(app)/reviews/experts/page";
import ExpertPage from "@/app/(app)/reviews/experts/[id]/page";
import QueuePage from "@/app/(app)/reviews/experts/queue/page";
import TechniquesPage from "@/app/(app)/reviews/techniques/page";
import {
  loadExpertDetail,
  loadExpertDirectory,
  loadQueue,
  loadTechniques,
  NOT_SCREENED_TEXT,
  SKIPPED_TEXT,
} from "@/lib/ui/loaders/experts";

afterAll(cleanupTempDbs);
process.env.PII_HASH_KEY = ENV.PII_HASH_KEY;

const text = (html: string) =>
  html
    .replace(/<script.*?<\/script>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const as = (w: World, who: "owner" | "editor" | "viewer") => {
  mem.main = w.main;
  mem.auth = w.auth;
  mem.user = {
    id: w[who],
    email: `${who}@example.test`,
    name: null,
    role: who,
  };
};
const D = "2026-10-19"; // the same ISO week as NOW (Tuesday 2026-10-20 in Melbourne)

async function exec(db: Client, sql: string, args: (string | number | null)[] = []) {
  await db.execute({ sql, args });
}

async function expertRow(
  db: Client,
  id: string,
  name: string,
  audience: number | null,
): Promise<void> {
  await exec(
    db,
    `INSERT INTO expert (id, name, status, tier, audience_size, audience_d, created_at, updated_at)
     VALUES (?, ?, 'tracked', 'core', ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    [id, name, audience, audience === null ? null : "2026-09-30"],
  );
}
/** `n` testable method claims for the expert, each in its own cluster; the first `pass` clusters survive. */
async function scoredClaims(
  db: Client,
  expert: string,
  tag: string,
  n: number,
  pass: number,
): Promise<{ cluster: string; survived: boolean }[]> {
  const out: { cluster: string; survived: boolean }[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = `K-${tag}${i}`;
    await exec(
      db,
      `INSERT INTO cluster (id, name, category, statement, testability, external_grade, created_at)
       VALUES (?, ?, 'trend_momentum', 'ZZ statement.', 'testable_eod', 'none', '2026-10-01T00:00:00.000Z')`,
      [k, `ZZ cluster ${tag}${i}`],
    );
    await exec(
      db,
      "INSERT INTO cluster_state (cluster_id, seq, state, actor, at) VALUES (?, 1, 'proposed', 'seed', '2026-10-01T00:00:00.000Z')",
      [k],
    );
    const id = `C-${tag}${i}`;
    await insertClaim(db, {
      id,
      type: "method",
      testability: "testable_eod",
      clusterId: k,
      statement: `ZZ claim ${tag}${i}`,
      actor: "seed",
      at: "2026-10-01T00:00:00.000Z",
    });
    await exec(db, "INSERT INTO claim_expert (claim_id, expert_id) VALUES (?, ?)", [id, expert]);
    out.push({ cluster: k, survived: i < pass });
  }
  return out;
}

describe("AT-41 (a): the directory is ordered by evidence, never by audience", () => {
  let w: World;
  beforeAll(async () => {
    w = await zzWorld();
  });

  it("puts the quiet expert with passing claims above the loud one with failing claims; thin evidence last", async () => {
    const main = await freshDb("main");
    const auth = await freshDb("auth");
    const world: World = { main, auth, ...(await usersIn(auth)) };
    await expertRow(main, "X-LOUD", "ZZ Loud Author", 9_000_000);
    await expertRow(main, "X-QUIET", "ZZ Quiet Author", 100);
    await expertRow(main, "X-THIN", "ZZ Thin Author", 50_000_000);
    const rows = [
      ...(await scoredClaims(main, "X-LOUD", "L", 10, 2)),
      ...(await scoredClaims(main, "X-QUIET", "Q", 10, 8)),
      ...(await scoredClaims(main, "X-THIN", "T", 2, 2)),
    ];
    await addRun(main, D, rows);
    as(world, "viewer");
    const html = renderToStaticMarkup(await ExpertsPage({ searchParams: Promise.resolve({}) }));
    const at = (s: string) => html.indexOf(s);
    expect(at("ZZ Quiet Author")).toBeGreaterThan(-1);
    expect(at("ZZ Quiet Author")).toBeLessThan(at("ZZ Loud Author"));
    expect(at("ZZ Loud Author")).toBeLessThan(at("ZZ Thin Author"));
    // 2 scored claims is below the minimum: the words, not a number (KB-074)
    const t = text(html);
    expect(t).toContain("not enough tested claims");
    expect(t).toContain("8 of 10 tested claims passed screening");
    // audience size is not shown in the list and no column sorts by it
    expect(t).not.toContain("9,000,000");
    expect(html).not.toMatch(/sortHref|aria-sort/);
    // the filtered list keeps the same order
    const filtered = renderToStaticMarkup(
      await ExpertsPage({ searchParams: Promise.resolve({ status: "tracked" }) }),
    );
    expect(filtered.indexOf("ZZ Quiet Author")).toBeLessThan(filtered.indexOf("ZZ Loud Author"));
    // the loader agrees
    const dir = await loadExpertDirectory({ mainDb: main, authDb: auth, user: OWNER, now: NOW });
    expect(dir.rows.map((r) => r.id)).toEqual(["X-QUIET", "X-LOUD", "X-THIN"]);
  });

  it("a Viewer cannot see an invalid filter value as a page: it is a 404", async () => {
    as(w, "viewer");
    await expect(
      ExpertsPage({ searchParams: Promise.resolve({ status: "bogus" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("expert detail and red flags (D-521)", () => {
  let w: World;
  beforeAll(async () => {
    w = await zzWorld();
  });

  it("Owner and Editor see the red-flag text and its source; the link goes out with nofollow", async () => {
    for (const who of ["owner", "editor"] as const) {
      as(w, who);
      const html = renderToStaticMarkup(
        await ExpertPage({ params: Promise.resolve({ id: "X-ZZ2" }) }),
      );
      expect(text(html)).toContain("ZZ synthetic caveat");
      expect(html).toContain("https://zz2.example.test/caveat");
      expect(html).toMatch(/rel="noopener nofollow noreferrer"/);
    }
  });

  it("a Viewer sees an icon and a count and never the text or the source (page and loader)", async () => {
    as(w, "viewer");
    const html = renderToStaticMarkup(
      await ExpertPage({ params: Promise.resolve({ id: "X-ZZ2" }) }),
    );
    const t = text(html);
    expect(t).toContain("1 red flag is noted");
    expect(t).not.toContain("ZZ synthetic caveat");
    expect(html).not.toContain("zz2.example.test/caveat");
    expect(html).toContain('data-red-flags="1"');
    const out = await loadExpertDetail(
      { mainDb: w.main, authDb: w.auth, user: { id: w.viewer, role: "viewer" }, now: NOW },
      "X-ZZ2",
    );
    expect(JSON.stringify(out)).not.toContain("caveat");
    expect(out!.data.redFlags.items).toEqual([]);
    expect(out!.data.redFlags.count).toBe(1);
  });

  it("says Reach, not skill with the audience size; claimed results are labelled claimed", async () => {
    as(w, "owner");
    const html = renderToStaticMarkup(
      await ExpertPage({ params: Promise.resolve({ id: "X-ZZ1" }) }),
    );
    const t = text(html);
    expect(t).toContain("Reach, not skill");
    expect(t).toContain("Audience size 12,000");
    const other = text(
      renderToStaticMarkup(await ExpertPage({ params: Promise.resolve({ id: "X-ZZ3" }) })),
    );
    expect(other).toContain("Claimed result: ZZ claimed edge");
    expect(t).toContain("Development split only; not a forecast.");
    expect(t).toContain("Not checked"); // licence status word (D-520)
  });

  it("an unknown id and a malformed id are 404", async () => {
    as(w, "owner");
    await expect(ExpertPage({ params: Promise.resolve({ id: "X-NOPE" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(ExpertPage({ params: Promise.resolve({ id: "a/b" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("claims queue roles (D-529)", () => {
  let w: World;
  beforeAll(async () => {
    w = await zzWorld();
  });

  it("a Viewer gets a 403 and the refusal is audited", async () => {
    as(w, "viewer");
    await expect(QueuePage()).rejects.toThrow("NEXT_FORBIDDEN");
    const a = (await auditRows(w.auth)).filter((x) => x.action === "auth.forbidden");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatchObject({
      action: "review_claims",
      path: "/reviews/experts/queue",
      role: "viewer",
    });
  });

  it("an Editor and the Owner open it: every control is a labelled button", async () => {
    for (const who of ["editor", "owner"] as const) {
      as(w, who);
      const html = renderToStaticMarkup(await QueuePage());
      const t = text(html);
      expect(t).toContain("Claims to check");
      expect(html).toContain('aria-label="Confirm claim C-ZZ-001"');
      expect(html).toContain('aria-label="Reject claim C-ZZ-001"');
      expect(html).toContain('aria-label="Park claim C-ZZ-001"');
      expect(html).toContain('aria-label="Confirm group K-ZZ1"');
      expect(html).toMatch(/aria-label="Confirm all \d+ claims by ZZ Expert 1"/);
      // the queue says confirming does not say the method works
      expect(t).toContain("it does not say the method works");
      expect(t).not.toMatch(/\b(certain|certainly|guaranteed|will)\b/i);
    }
  });

  it("the queue lists only claims still to check, grouped by expert, with source links", async () => {
    const q = await loadQueue({
      mainDb: w.main,
      authDb: w.auth,
      user: { id: w.owner, role: "owner" },
      now: NOW,
    });
    expect(q.total).toBe(q.experts.reduce((n, e) => n + e.claims.length, 0));
    expect(q.total).toBeGreaterThan(18);
    const first = q.experts[0]!.claims[0]!;
    expect(first.sources.length).toBeGreaterThan(0);
    expect(q.toConfirm.map((k) => k.id)).toContain("K-ZZ1");
    expect(q.targets).toEqual([]); // nothing is confirmed yet, so nothing to merge into
  });
});

describe("masking (ROL-107)", () => {
  it("a masked viewer sees neither codes nor names in claims, summaries, red flags, calls and gaps", async () => {
    const db = await emptyDbs();
    await seedPopulated(db);
    await importSeed(db.main, (f) => {
      f["claims.json"].claims[0].statement = "ZZ buy ZZUP on breakouts";
      f["claims.json"].claims[0].vocabulary_gap = "ZZUP order book depth";
      f["items.json"].items[0].summary = "ZZ note on Zed Upward Holdings, our own words.";
      f["experts.json"].experts[1].red_flags[0].text = "ZZ caveat naming Zed Downward Mining.";
      f["calls.json"]!.calls[0].code = "ZZUP";
    });
    const own = await loadExpertDetail(
      { mainDb: db.main, authDb: db.auth, user: OWNER, now: NOW },
      "X-ZZ1",
    );
    expect(JSON.stringify(own)).toContain("ZZUP");
    expect(own!.masked).toBe(false);
    for (const who of [EDITOR, VIEWER]) {
      for (const id of ["X-ZZ1", "X-ZZ2"]) {
        const out = await loadExpertDetail(
          { mainDb: db.main, authDb: db.auth, user: who, now: NOW },
          id,
        );
        expect(out!.masked).toBe(true);
        const blob = JSON.stringify(out);
        expect(blob).not.toMatch(/ZZUP|ZZDN|Zed Upward|Zed Downward/);
        expect(leaks(out)).toEqual([]);
      }
      const tech = await loadTechniques({ mainDb: db.main, authDb: db.auth, user: who, now: NOW });
      expect(JSON.stringify(tech)).not.toMatch(/ZZUP|Zed Upward/);
      expect(tech.masked).toBe(true);
      const q = await loadQueue({ mainDb: db.main, authDb: db.auth, user: who, now: NOW });
      expect(JSON.stringify(q)).not.toMatch(/ZZUP|Zed Upward/);
      expect(q.masked).toBe(true);
    }
    // an expert's name is not a code: it stays visible to every role
    const viewer = await loadExpertDirectory({
      mainDb: db.main,
      authDb: db.auth,
      user: VIEWER,
      now: NOW,
    });
    expect(viewer.rows.map((r) => r.name)).toContain("ZZ Expert 1");
  });

  it("editing is switched off in the queue while text is masked", async () => {
    const db = await emptyDbs();
    await seedPopulated(db);
    await importSeed(db.main);
    const w: World = { main: db.main, auth: db.auth, owner: 1, editor: 2, viewer: 3 }; // seedPopulated users
    as(w, "editor"); // an Editor without an unmask grant is masked
    const html = renderToStaticMarkup(await QueuePage());
    expect(html).not.toContain('aria-label="Edit claim');
    expect(text(html)).toContain("Editing is switched off while text is hidden");
    as(w, "owner");
    expect(renderToStaticMarkup(await QueuePage())).toContain('aria-label="Edit claim C-ZZ-001"');
  });
});

describe("techniques: why a cluster has no result (D-599), park reasons, gap report (KB-079)", () => {
  let w: World;
  beforeAll(async () => {
    w = await zzWorld();
    // two confirmed clusters with a valid family fit and a supporting checked claim
    for (const id of ["K-ZZ8", "K-ZZ9"]) {
      await exec(
        w.main,
        `INSERT INTO cluster (id, name, category, statement, testability, external_grade, family_fit_json, created_at)
         VALUES (?, ?, 'trend_momentum', 'ZZ fit statement.', 'testable_eod', 'none', ?, '2026-10-01T00:00:00.000Z')`,
        [id, `ZZ fit ${id}`, JSON.stringify(f1Fit(2))],
      );
      for (const [seq, st] of [
        [1, "proposed"],
        [2, "confirmed"],
      ] as const)
        await exec(
          w.main,
          "INSERT INTO cluster_state (cluster_id, seq, state, actor, at) VALUES (?, ?, ?, 'u', '2026-10-01T00:00:00.000Z')",
          [id, seq, st],
        );
    }
    // K-ZZ3 (closest family "new", testable) confirmed -> needs a new lineage
    await exec(
      w.main,
      "INSERT INTO cluster_state (cluster_id, seq, state, actor, at) VALUES ('K-ZZ3', 2, 'confirmed', 'u', '2026-10-01T00:00:00.000Z')",
    );
  });
  const deps = (now: Date, role = "viewer") => ({
    mainDb: w.main,
    authDb: w.auth,
    user: { id: w.viewer, role },
    now,
  });
  const row = (m: Awaited<ReturnType<typeof loadTechniques>>, id: string) =>
    m.rows.find((r) => r.id === id)!;

  it("no run for the week: not screened this week; parked and proposed clusters say so", async () => {
    const m = await loadTechniques(deps(NOW));
    expect(row(m, "K-ZZ9").screeningNote).toBe(NOT_SCREENED_TEXT);
    expect(row(m, "K-ZZ1").screeningNote).toBe("waiting for a person to confirm the group");
    expect(row(m, "K-ZZ1").parkText).toBe("its family fit did not pass the check");
    expect(row(m, "K-ZZ3").parkText).toBe("needs a new lineage (build change)");
    expect(row(m, "K-ZZ3").screeningNote).toBe("needs a new lineage (build change)");
    expect(row(m, "K-ZZ4").parkText).toBe("an overlay, not a stand-alone rule (build change)");
    expect(m.parkedForBuild).toBe(1);
  });

  it("a run this week without a row for the cluster: skipped; with a row: the result as percentages", async () => {
    await addRun(w.main, D, [{ cluster: "K-ZZ9", survived: true, rank: 1 }]);
    const m = await loadTechniques(deps(NOW));
    expect(row(m, "K-ZZ8").screeningNote).toBe(SKIPPED_TEXT);
    const r = row(m, "K-ZZ9").result!;
    expect(r).toMatchObject({
      family: "F1",
      controlledRows: 40,
      blocks: 8,
      meanNetPct: 1.2,
      meanExcessPct: 1.5,
      lower90Pct: 0.4,
      survived: true,
      rank: 1,
      grade: "L1",
    });
    // a run from an earlier week does not count as this week
    const later = new Date("2026-11-10T03:00:00.000Z");
    expect(row(await loadTechniques(deps(later)), "K-ZZ8").screeningNote).toBe(NOT_SCREENED_TEXT);
  });

  it("renders the page: controlled rows label, caption, no money, the gap report and the banner", async () => {
    as(w, "viewer");
    const html = renderToStaticMarkup(await TechniquesPage({ searchParams: Promise.resolve({}) }));
    const t = text(html);
    expect(t).toContain("Controlled rows");
    expect(t).toContain("Mean excess over matched controls");
    expect(t).toContain("Development split only; not a forecast.");
    expect(t).toContain("needs a new lineage (build change)");
    expect(t).toContain("Waiting for a build change");
    expect(t).toMatch(/\d+ experts? (rely|relies) on .* \(not in Praxis\)/);
    expect(t).not.toMatch(/\$|A\$/);
    expect(t).not.toMatch(/\b(certain|certainly|guaranteed|will)\b/i);
    expect(html).toContain('id="K-ZZ9"');
    // the category filter narrows the list
    const only = renderToStaticMarkup(
      await TechniquesPage({ searchParams: Promise.resolve({ category: "volume" }) }),
    );
    expect(only).toContain('id="K-ZZ3"');
    expect(only).not.toContain('id="K-ZZ9"');
    await expect(
      TechniquesPage({ searchParams: Promise.resolve({ category: "bogus" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("links the challenger and states the proposal", async () => {
    await exec(
      w.main,
      `INSERT INTO expert_proposal (id, market, d, cluster_id, kind, family, challenger_id, status, reason, created_at)
       VALUES ('expprop:AU:${D}:K-ZZ9', 'AU', ?, 'K-ZZ9', 'challenger', 'F1', 'ch-zz-1', 'created', NULL, ?)`,
      [D, `${D}T00:00:00.000Z`],
    );
    as(w, "owner");
    const html = renderToStaticMarkup(await TechniquesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('href="/reviews/learned/challengers/ch-zz-1"');
    expect(text(html)).toContain("challenger created");
  });
});
