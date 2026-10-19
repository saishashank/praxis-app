// @vitest-environment node
// Evening Review assembly and storage (M5 T9; EML-010...016, EML-035, UXN-113, AT-20 content parts).
// The facts are rendered with the T4 templates (so the fact types are exactly what the renderer
// expects), stored as versioned `evening_review` rows, and the R5 narrative row is produced through
// the LLM router in mock and rules-only mode. No Resend, no live model.
import { afterEach, describe, expect, it } from "vitest";
import { narrativeStage } from "@/lib/agents/batch3";
import { REVIEW_MAX_BYTES, renderReview } from "@/lib/email/templates";
import {
  assembleReview,
  buildFacts,
  listVersions,
  loadReview,
  markRead,
  readState,
} from "@/lib/review/assemble";
import { REVIEW_SECTION_NAMES, factsSha } from "@/lib/review/facts";
import {
  NARRATIVE_TEMPLATE_VERSION,
  loadCtx,
  narrativeRequest,
  readNarrativePack,
  readNarrativeRow,
} from "@/lib/review/sections";
import { buildPrompt } from "@/lib/llm/router";
import { createMockProvider, promptSha } from "@/lib/llm/providers";
import { cleanupTempDbs } from "../db/helpers";
import { makeRouter, MOCK_MODEL } from "../llm/helpers";
import {
  APP,
  D,
  MARKET,
  NOW,
  PREV,
  SAT,
  addMarker,
  addNav,
  addPending,
  cohortOf,
  exec,
  mainWorld,
  tradingDay,
} from "./helpers";

afterEach(cleanupTempDbs);

const opts = (d = D) => ({ market: MARKET, d, env: "production" as const, appUrl: APP, now: NOW });

function headings(text: string): void {
  REVIEW_SECTION_NAMES.forEach((name, i) => {
    expect(text, `section ${i + 1}`).toContain(`${i + 1}. ${name}`);
  });
}

describe("rendering with the T4 templates", () => {
  it("full review: all ten headings, KPI row, under 90 KB, deterministic", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addPending(db, e01, "o-pend", "ZZP");
    const a = await buildFacts(db, opts());
    const b = await buildFacts(db, opts());
    expect(factsSha(a.facts)).toBe(factsSha(b.facts));
    const out = renderReview(a.facts);
    expect(out).toEqual(renderReview(b.facts));
    headings(out.text);
    expect(out.sizeHtml).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
    expect(out.subject).toBe("Praxis Evening Review — Mon 19 Oct 2026");
    expect(out.text).toContain("Written without AI today");
    expect(out.text).toContain("E01");
  });

  it("partial review: the EML-011 box lists the missing sections, no yesterday's numbers", async () => {
    const db = await mainWorld();
    const e01 = await cohortOf(db, "E01");
    await addNav(db, e01, PREV, 601_000_000n);
    const built = await buildFacts(db, opts());
    expect(built.kind).toBe("partial");
    const out = renderReview(built.facts);
    expect(out.subject).toContain("(partial)");
    expect(out.text).toContain("Partial review — not ready by 20:30:");
    expect(out.text).toContain("Section 1: Headline scorecard");
    expect(out.text).toContain("Section 7: Overall picture — success %");
    expect(out.text).not.toContain("601.00");
    headings(out.text);
  });

  it("non-trading variant keeps all ten headings", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await addMarker(db, SAT, "non-trading");
    const built = await buildFacts(db, opts(SAT));
    const out = renderReview(built.facts);
    expect(out.subject).toContain("(non-trading day)");
    headings(out.text);
    expect(out.text).toContain("No trading today.");
    expect(out.text).toContain("Market closed");
  });

  it("data-only mode: sections 1-7 say the arena is not active and the review is not partial", async () => {
    const db = await mainWorld({ mode: "data_only" });
    const built = await buildFacts(db, opts());
    expect(built.kind).toBe("full");
    const out = renderReview(built.facts);
    expect(out.text).toContain("Arena not active (data-only mode).");
    expect(out.text).not.toContain("Partial review");
    headings(out.text);
  });

  it("minimal review shows only that date's data: no yesterday, 'No data for <d>'", async () => {
    const db = await mainWorld();
    const e01 = await cohortOf(db, "E01");
    await addNav(db, e01, PREV, 601_000_000n);
    const built = await buildFacts(db, { ...opts(), minimal: { reason: "Normal path failed." } });
    const out = renderReview(built.facts);
    expect(out.subject).toContain("(minimal)");
    expect(out.text).toContain(`No data for ${D}.`);
    expect(out.text).not.toContain("601.00");
  });

  it("UNREAD 3 DAYS prefixes the subject when the last three reviews were not read (EML-036)", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    for (const d of ["2026-10-14", "2026-10-15", PREV]) {
      await exec(
        db,
        `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
         VALUES (?, 1, 'full', '{}', ?, '', '', '', 0, 'rules', ?)`,
        [d, "a".repeat(64), `${d}T09:00:00.000Z`],
      );
    }
    const built = await buildFacts(db, opts());
    expect(built.facts.unreadDays).toBe(3);
    expect(renderReview(built.facts).subject).toContain("UNREAD 3 DAYS");
    await markRead(db, PREV, "page", NOW);
    const after = await buildFacts(db, opts());
    expect(after.facts.unreadDays).toBeUndefined();
  });
});

describe("storage: versions, idempotency, kinds", () => {
  it("writes one version per distinct facts and kind; a second run is a no-op", async () => {
    const db = await mainWorld();
    const p1 = await assembleReview(db, opts());
    expect(p1).toMatchObject({ version: 1, kind: "partial", created: true });
    expect(p1.missing.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const again = await assembleReview(db, opts());
    expect(again).toMatchObject({ version: 1, created: false, factsSha: p1.factsSha });
    // the pipeline finishes: the complete version is stored later as v2 (EML-011)
    await tradingDay(db);
    const full = await assembleReview(db, opts());
    expect(full).toMatchObject({ version: 2, kind: "full", created: true, missing: [] });
    const same = await assembleReview(db, opts());
    expect(same).toMatchObject({ version: 2, created: false });
    const versions = await listVersions(db, D);
    expect(versions.map((v) => [v.version, v.kind])).toEqual([
      [1, "partial"],
      [2, "full"],
    ]);
    const row = (await exec(db, "SELECT * FROM evening_review WHERE d = ? AND version = 2", [D]))
      .rows[0]!;
    expect(String(row.facts_sha)).toBe(full.factsSha);
    expect(JSON.parse(String(row.facts_json))).toMatchObject({ date: D, variant: "full" });
    expect(Number(row.size_html)).toBe(full.sizeHtml);
    expect(String(row.markdown)).toContain("# Praxis Evening Review");
    expect(String(row.narrative)).toBe("rules");
    const loaded = await loadReview(db, D);
    expect(loaded?.version).toBe(2);
    expect((await loadReview(db, D, 1))?.kind).toBe("partial");
    expect(await loadReview(db, "2026-01-01")).toBeNull();
  });

  it("stores the non-trading and minimal kinds", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const nt = await assembleReview(db, opts(SAT));
    expect(nt.kind).toBe("non_trading");
    const min = await assembleReview(db, { ...opts(), minimal: { reason: "x" } });
    expect(min.kind).toBe("minimal");
    expect(min.version).toBe(1);
    expect(min.markerPresent).toBe(true);
  });
});

describe("mark as read", () => {
  it("records the first read of a date once, with how it was read", async () => {
    const db = await mainWorld();
    expect(await readState(db, D)).toBeNull();
    expect(await markRead(db, D, "email_link", NOW)).toEqual({ firstRead: true });
    expect(await markRead(db, D, "page", new Date(NOW.getTime() + 1000))).toEqual({
      firstRead: false,
    });
    expect(await readState(db, D)).toEqual({ readAt: NOW.toISOString(), via: "email_link" });
  });
});

describe("R5 narrative (batch 3) through the router", () => {
  async function requestFor(db: Awaited<ReturnType<typeof mainWorld>>) {
    const c = await loadCtx(db, { ...opts(), env: "production" });
    const pack = await readNarrativePack(c);
    return narrativeRequest(MARKET, pack, false);
  }
  const answer = {
    s4: ["E01 and E02 were tracked on 2026-10-19."],
    s5: ["E01 did best on the day."],
    s6: ["The next session is 2026-10-20."],
  };

  it("mock mode: a grounded fixture answer is stored and used, with mock provenance (UXN-113)", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const req = await requestFor(db);
    const sha = promptSha(
      "R5",
      MOCK_MODEL,
      NARRATIVE_TEMPLATE_VERSION,
      buildPrompt(req.task, req.facts, [], false),
    );
    const provider = createMockProvider({
      model: MOCK_MODEL,
      roles: ["R5"],
      fixtures: { [sha]: { text: JSON.stringify(answer), tokensIn: 100, tokensOut: 40 } },
    });
    const { router } = makeRouter("mock", [provider]);
    expect(
      await narrativeStage(db, { market: MARKET, d: D, now: () => NOW.toISOString() }, router),
    ).toBe("llm");
    const row = await readNarrativeRow(db, MARKET, D);
    expect(row).toMatchObject({ kind: "llm", provider: "mock", ...answer });
    const out = await assembleReview(db, opts());
    expect(out.narrative).toBe("mock");
    expect(out.text).toContain("E01 did best on the day.");
    expect(out.text).not.toContain("Written without AI today");
  });

  it("an ungrounded answer (a number not in the facts) is rejected and the facts-only lists are stored", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const req = await requestFor(db);
    const bad = { ...answer, s5: ["E01 gained 99999 dollars."] };
    const sha = promptSha(
      "R5",
      MOCK_MODEL,
      NARRATIVE_TEMPLATE_VERSION,
      buildPrompt(req.task, req.facts, [], false),
    );
    const provider = createMockProvider({
      model: MOCK_MODEL,
      roles: ["R5"],
      fixtures: { [sha]: { text: JSON.stringify(bad), tokensIn: 100, tokensOut: 40 } },
    });
    const { router } = makeRouter("mock", [provider]);
    expect(
      await narrativeStage(db, { market: MARKET, d: D, now: () => NOW.toISOString() }, router),
    ).toBe("rules");
    const row = await readNarrativeRow(db, MARKET, D);
    expect(row?.kind).toBe("rules");
    const out = await assembleReview(db, opts());
    expect(out.narrative).toBe("rules");
    expect(out.text).toContain("Written without AI today");
    expect(out.text).not.toContain("99999");
  });

  it("rules-only mode and a missing row both give the 'Written without AI today' facts", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { router } = makeRouter("rules-only", []);
    expect(
      await narrativeStage(db, { market: MARKET, d: D, now: () => NOW.toISOString() }, router),
    ).toBe("rules");
    expect((await readNarrativeRow(db, MARKET, D))?.provider).toBe("rules-only");
    const none = await mainWorld();
    await tradingDay(none);
    expect(await readNarrativeRow(none, MARKET, D)).toBeNull();
    const out = await assembleReview(none, opts());
    expect(out.text).toContain("Written without AI today");
  });

  it("rejects a malformed stored row (the request path never trusts it)", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await exec(
      db,
      "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, 'narrative', ?, ?)",
      [
        `arena-3:${MARKET}:${D}`,
        `review:${MARKET}:${D}`,
        D,
        JSON.stringify({ kind: "llm", s4: "x" }),
      ],
    );
    expect(await readNarrativeRow(db, MARKET, D)).toBeNull();
  });
});
