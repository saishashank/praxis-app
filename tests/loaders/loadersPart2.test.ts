// @vitest-environment node
// M7 T8 page data loaders, part 2 (D-136 draft): picks, market, news, alerts, reviews, knowledge, health,
// usage, settings and shell. Per loader: empty state, populated state, query validation, role matrix
// and masking leak tests (a masked user's model must hold no code, company name, price or link).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { findLeaks } from "@/lib/view/mask";
import { loadAlerts, parseAlertsQuery } from "@/lib/ui/loaders/alerts";
import { loadHealth } from "@/lib/ui/loaders/health";
import { loadKnowledge, parseKnowledgeQuery } from "@/lib/ui/loaders/knowledge";
import {
  loadMarket,
  loadOverview,
  parseMarketQuery,
  parseSearchQuery,
  searchInstruments,
} from "@/lib/ui/loaders/market";
import { loadNews, loadNewsItem, parseNewsQuery } from "@/lib/ui/loaders/news";
import {
  loadPickDetail,
  loadPicks,
  loadTrackRecord,
  parsePickId,
  parsePicksQuery,
} from "@/lib/ui/loaders/picks";
import { loadReviewList, loadReviewPage, parseReviewsQuery } from "@/lib/ui/loaders/reviews";
import { loadSettings } from "@/lib/ui/loaders/settings";
import { intParam, loadShell, textParam } from "@/lib/ui/loaders/shell";
import { loadUsage } from "@/lib/ui/loaders/usage";
import { CODES, D, emptyWorld, envOf, fullWorld, NAMES, type Who, type World } from "./world";

afterAll(cleanupTempDbs);

const MASKED: Who[] = ["editor", "viewer"];
const UNMASKED: Who[] = ["owner", "granted"];
const sp = (s: string) => new URLSearchParams(s);
const noLeak = (model: unknown) => expect(findLeaks(model, CODES, NAMES)).toEqual([]);
const priceish = /example\.test|A\$\s?\d|\$\d|10500000|11000000|9200000|10050000/;

describe("shared parameter helpers", () => {
  it("intParam and textParam accept good values and refuse bad ones", () => {
    expect(intParam(undefined, 1, 10)).toBe(1);
    expect(intParam("7", 1, 10)).toBe(7);
    for (const bad of ["0", "11", "-1", "1.5", "x", "99999999"])
      expect(intParam(bad, 1, 10)).toBeNull();
    expect(textParam(undefined)).toBeUndefined();
    expect(textParam("  ")).toBeUndefined();
    expect(textParam(" abc ")).toBe("abc");
    expect(textParam("a".repeat(61))).toBeNull();
    expect(textParam("a\u0000b")).toBeNull();
  });
});

describe("empty state (no data at all)", () => {
  let w: World;
  beforeAll(async () => {
    w = await emptyWorld();
  });
  it("every list loader answers empty, never throws", async () => {
    for (const who of ["owner", "viewer"] as Who[]) {
      const env = envOf(w, who);
      expect((await loadPicks(env, { profile: "balanced" })).state).toBe("empty");
      expect((await loadTrackRecord(env, { profile: "balanced" })).state).toBe("empty");
      expect((await loadMarket(env, { tab: "movers", page: 1 })).state).toBe("empty");
      expect((await loadNews(env, { chip: "all", page: 1 })).state).toBe("empty");
      expect((await loadAlerts(env, { unacked: false })).state).toBe("empty");
      const reviews = await loadReviewList(env, { page: 1 });
      expect(reviews.state).toBe("empty");
      expect(reviews.pending).toBe(true);
      expect((await loadKnowledge(env, {})).state).toBe("empty");
      expect((await searchInstruments(env, "zz")).state).toBe("empty");
    }
  });
  it("detail loaders answer null for what is not stored", async () => {
    const env = envOf(w, "owner");
    expect(await loadPickDetail(env, `${D}.balanced.1`)).toBeNull();
    expect(await loadNewsItem(env, 1)).toBeNull();
    expect(await loadOverview(env, "ZZUP")).toBeNull();
    expect(await loadReviewPage(env, D)).toBeNull();
  });
  it("the settings and shell loaders still answer", async () => {
    const env = envOf(w, "owner");
    expect((await loadSettings(env)).preferences.theme).toBe("dark");
    const shell = await loadShell(env);
    expect(shell.bell.count).toBe(0);
    expect(shell.masked).toBe(false);
  });
});

describe("populated loaders", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
  });

  describe("picks", () => {
    it("validates the query", async () => {
      const env = envOf(w, "owner");
      expect(await parsePicksQuery(env, sp("profile=balanced&d=2026-10-19"))).toEqual({
        profile: "balanced",
        d: "2026-10-19",
      });
      expect((await parsePicksQuery(env, sp("")))?.profile).toBe("balanced");
      for (const bad of [
        "profile=reckless",
        "profile=Balanced",
        "d=2026-13-40",
        "d=yesterday",
        "profile=%27%3B",
      ]) {
        expect(await parsePicksQuery(env, sp(bad))).toBeNull();
      }
      expect(parsePickId(`${D}.balanced.1`)).toEqual({ d: D, profile: "balanced", rank: 1 });
      for (const bad of [
        "x",
        `${D}.balanced.0`,
        `${D}.balanced.11`,
        `${D}.BAL.1`,
        `${D}.balanced`,
      ]) {
        expect(parsePickId(bad)).toBeNull();
      }
    });
    it("shows prices and codes to the Owner and to a user with a grant", async () => {
      for (const who of UNMASKED) {
        const m = await loadPicks(envOf(w, who), { profile: "balanced" });
        expect(m.state).toBe("ok");
        expect(m.masked).toBe(false);
        expect(m.d).toBe(D);
        expect(m.picks.map((p) => p.stock)).toEqual(["ZZUP", "ZZOTH"]);
        expect(m.picks[0]!.company).toBe("Zed Upward Holdings");
        expect(m.picks[0]!.buyUpTo).toEqual({
          micro: "10050000",
          currency: "AUD",
          simulated: true,
        });
        expect(m.success?.measured).toBe(false);
        expect(m.success?.line).toContain("not measured yet");
      }
    });
    it("masks everything for Editor and Viewer, on the list, the detail and the track record", async () => {
      for (const who of MASKED) {
        const env = envOf(w, who);
        const list = await loadPicks(env, { profile: "balanced" });
        expect(list.picks.map((p) => p.stock)).toEqual(["Stock C", "Stock B"]);
        expect(list.picks[0]).toMatchObject({
          company: null,
          buyUpTo: null,
          stop: null,
          aim: null,
        });
        expect(list.d).toBe("2026-W43");
        const detail = await loadPickDetail(env, `${D}.balanced.1`);
        expect(detail?.pick.stock).toBe("Stock C");
        expect(detail?.outcome).toMatchObject({
          state: "closed",
          entry: null,
          exit: null,
          netPpm: 50000,
        });
        const track = await loadTrackRecord(env, { profile: "balanced" });
        expect(track.rows[0]).toMatchObject({
          stock: "Stock C",
          entry: null,
          exit: null,
          d: "2026-W43",
        });
        for (const model of [list, detail, track]) {
          noLeak(model);
          expect(JSON.stringify(model)).not.toMatch(priceish);
          // The pick id is the address of the page (date.profile.rank); every other date is a week.
          expect(JSON.stringify(model).replace(/"id":"[^"]*"/g, "")).not.toContain(D);
        }
      }
    });
    it("the detail shows the factors and a closed outcome to the Owner", async () => {
      const d = await loadPickDetail(envOf(w, "owner"), `${D}.balanced.1`);
      expect(d?.factors[0]).toMatchObject({ factor: "Volume of ZZUP", n: 40 });
      expect(d?.outcome?.exit?.micro).toBe("10500000");
      expect(await loadPickDetail(envOf(w, "owner"), `${D}.balanced.9`)).toBeNull();
      expect(await loadPickDetail(envOf(w, "owner"), "garbage")).toBeNull();
    });
    it("is stale when the newest pick is old", async () => {
      const later = new Date("2026-10-30T03:00:00.000Z");
      const m = await loadPicks({ ...envOf(w, "owner"), now: later }, { profile: "balanced" });
      expect(m.state).toBe("stale");
      expect(m.staleText).toContain(D);
    });
  });

  describe("market", () => {
    it("validates the query", () => {
      expect(parseMarketQuery(sp(""))).toEqual({ tab: "movers", sector: undefined, page: 1 });
      expect(parseMarketQuery(sp("tab=all&page=2&sector=Technology"))?.page).toBe(2);
      for (const bad of ["tab=nope", "page=0", "page=x", `sector=${"a".repeat(61)}`]) {
        expect(parseMarketQuery(sp(bad))).toBeNull();
      }
      expect(parseSearchQuery(sp("q=zz"))).toBe("zz");
      for (const bad of ["", "q=", "q=a%00b", `q=${"a".repeat(41)}`, "q=%3Cscript%3E", "q=a%25b"]) {
        expect(parseSearchQuery(sp(bad))).toBeNull();
      }
    });
    it("the Owner sees movers, sectors and the table with prices", async () => {
      const env = envOf(w, "owner");
      const movers = await loadMarket(env, { tab: "movers", page: 1 });
      expect(movers.state).toBe("ok");
      expect(movers.up.map((r) => r.stock)).toEqual(["ZZOTH", "ZZUP"]); // +10 %, +5 %
      expect(movers.down.map((r) => r.stock)).toEqual(["ZZDN"]);
      expect(movers.up[1]).toMatchObject({ name: "Zed Upward Holdings", changePpm: 50000 });
      expect(movers.up[1]!.close).toEqual({ micro: "10500000", currency: "AUD", simulated: true });
      const sectors = await loadMarket(env, { tab: "sectors", page: 1 });
      expect(sectors.sectors.map((s) => s.sector)).toEqual(["Materials", "Other", "Technology"]);
      const all = await loadMarket(env, { tab: "all", sector: "Technology", page: 1 });
      expect(all.rows.map((r) => r.stock)).toEqual(["ZZUP"]);
      expect(all.page.total).toBe(1);
    });
    it("masked users see only the active stocks, as letters, with derived numbers", async () => {
      for (const who of MASKED) {
        const env = envOf(w, who);
        const all = await loadMarket(env, { tab: "all", page: 1 });
        expect(all.rows.map((r) => r.stock)).toEqual(["Stock A", "Stock B"]); // ZZDN, ZZUP
        expect(all.rows[1]).toMatchObject({
          slug: "stock-b",
          name: null,
          close: null,
          changePpm: 50000,
        });
        const movers = await loadMarket(env, { tab: "movers", page: 1 });
        const sectors = await loadMarket(env, { tab: "sectors", page: 1 });
        expect(sectors.sectors).toEqual([]);
        for (const model of [all, movers, sectors]) {
          noLeak(model);
          expect(JSON.stringify(model)).not.toMatch(/Technology|Materials|10500000/);
        }
      }
    });
    it("search finds by code and name for the Owner, nothing for a masked user", async () => {
      const own = await searchInstruments(envOf(w, "owner"), "zz");
      expect(own.results.map((r) => r.code)).toEqual(["ZZDN", "ZZOTH", "ZZUP"]);
      expect(
        (await searchInstruments(envOf(w, "owner"), "Upward")).results.map((r) => r.code),
      ).toEqual(["ZZUP"]);
      expect((await searchInstruments(envOf(w, "owner"), "no-such")).state).toBe("empty");
      expect((await searchInstruments(envOf(w, "owner"), "100%")).results).toEqual([]);
      for (const who of MASKED) {
        const out = await searchInstruments(envOf(w, who), "ZZUP");
        expect(out.results).toEqual([]);
        expect(out.note).toBeTruthy();
        noLeak(out);
      }
    });
    it("the star shows for the Owner watch list and the Editor list only", async () => {
      await w.main.execute({
        sql: `INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d)
              VALUES ('w1', 'AU', 'ZZUP', ?, '2026-10-01T00:00:00.000Z', '2026-12-01')`,
        args: [w.ids.owner],
      });
      await w.auth.execute({
        sql: "INSERT INTO user_watchlist (user_id, market, code, added_at) VALUES (?, 'AU', 'ZZDN', '2026-10-01T00:00:00.000Z')",
        args: [w.ids.editor],
      });
      expect(
        (await searchInstruments(envOf(w, "owner"), "zz")).results
          .filter((r) => r.starred)
          .map((r) => r.code),
      ).toEqual(["ZZUP"]);
      const ed = await searchInstruments({ ...envOf(w, "editor"), mask: { masked: false } }, "zz");
      expect(ed.results.filter((r) => r.starred).map((r) => r.code)).toEqual(["ZZDN"]);
      const vw = await searchInstruments({ ...envOf(w, "viewer"), mask: { masked: false } }, "zz");
      expect(vw.results.some((r) => r.starred)).toBe(false);
    });
    it("the overview is facts only; a masked user addresses it by slug", async () => {
      const own = await loadOverview(envOf(w, "owner"), "zzup");
      expect(own).toMatchObject({
        stock: "ZZUP",
        name: "Zed Upward Holdings",
        summary: "Summary not written yet",
      });
      expect(own?.announcements.length).toBe(1);
      expect(await loadOverview(envOf(w, "owner"), "bad code")).toBeNull();
      for (const who of MASKED) {
        const env = envOf(w, who);
        const m = await loadOverview(env, "stock-b");
        expect(m).toMatchObject({ stock: "Stock B", name: null, close: null, changePpm: 50000 });
        noLeak(m);
        expect(JSON.stringify(m)).not.toMatch(priceish);
        expect(await loadOverview(env, "ZZUP")).toBeNull(); // a real code is not accepted
        expect(await loadOverview(env, "ZZOTH")).toBeNull();
        expect(await loadOverview(env, "stock-z")).toBeNull();
      }
    });
    it("is stale when the newest bar is old", async () => {
      const m = await loadMarket(
        { ...envOf(w, "owner"), now: new Date("2026-11-20T03:00:00.000Z") },
        { tab: "movers", page: 1 },
      );
      expect(m.state).toBe("stale");
    });
  });

  describe("news and alerts", () => {
    it("validates the query", () => {
      expect(parseNewsQuery(sp(""))?.chip).toBe("mine");
      expect(parseNewsQuery(sp("chip=all&code=zzup&from=2026-10-01&to=2026-10-31"))).toMatchObject({
        chip: "all",
        code: "zzup",
      });
      for (const bad of [
        "chip=x",
        "code=a-b",
        "from=2026-13-01",
        "from=2026-10-31&to=2026-10-01",
        "page=0",
        `q=${"a".repeat(61)}`,
      ]) {
        expect(parseNewsQuery(sp(bad))).toBeNull();
      }
      expect(parseAlertsQuery(sp("tier=P0&unacked=1"))).toEqual({ tier: "P0", unacked: true });
      for (const bad of ["tier=P9", "unacked=maybe"]) expect(parseAlertsQuery(sp(bad))).toBeNull();
    });
    it("the Owner sees both items; filters work", async () => {
      const env = envOf(w, "owner");
      const all = await loadNews(env, { chip: "all", page: 1 });
      expect(all.items.map((i) => i.stock).sort()).toEqual(["ZZOTH", "ZZUP"]);
      const mine = await loadNews(env, { chip: "mine", page: 1 });
      expect(mine.items.map((i) => i.stock)).toEqual(["ZZUP"]);
      expect(mine.items[0]).toMatchObject({ heldByUs: true, polarity: 1, materiality: 3 });
      expect((await loadNews(env, { chip: "all", code: "zzoth", page: 1 })).items.length).toBe(1);
      expect((await loadNews(env, { chip: "all", q: "halt", page: 1 })).items.length).toBe(1);
      expect((await loadNews(env, { chip: "all", from: "2026-10-20", page: 1 })).state).toBe(
        "empty",
      );
      expect((await loadNews(env, { chip: "all", to: D, page: 1 })).items.length).toBe(2);
    });
    it("a masked user sees only active-set items, masked, and cannot probe by code or text", async () => {
      for (const who of MASKED) {
        const env = envOf(w, who);
        const all = await loadNews(env, { chip: "all", page: 1 });
        expect(all.items.map((i) => i.stock)).toEqual(["Stock B"]);
        expect(all.items[0]!.published).toBe("2026-W43");
        const probe = await loadNews(env, { chip: "all", code: "ZZOTH", q: "halt", page: 1 });
        expect(probe.items.map((i) => i.stock)).toEqual(["Stock B"]); // the filters are ignored
        const item = await loadNewsItem(env, w.annIds.up);
        expect(item).toMatchObject({ stock: "Stock B", company: null, url: null });
        expect(await loadNewsItem(env, w.annIds.oth)).toBeNull(); // not in the active set
        for (const model of [all, probe, item]) {
          noLeak(model);
          expect(JSON.stringify(model)).not.toMatch(priceish);
        }
      }
      const own = await loadNewsItem(envOf(w, "owner"), w.annIds.oth);
      expect(own).toMatchObject({
        stock: "ZZOTH",
        company: "Zed Other Group",
        url: "https://news.example.test/doc.pdf",
      });
    });
    it("alerts group by tier and mask for non-owners", async () => {
      const own = await loadAlerts(envOf(w, "owner"), { unacked: false });
      expect(own.state).toBe("ok");
      expect(own.groups.map((g) => g.tier)).toEqual(["P0", "P1"]);
      expect(own.groups[0]!.open).toBe(true);
      expect(own.groups[1]!.alerts[0]!.code).toBe("ZZUP");
      for (const who of MASKED) {
        const m = await loadAlerts(envOf(w, who), { unacked: false });
        expect(m.groups[1]!.alerts[0]!.code).toBe("Stock B");
        noLeak(m);
      }
    });
  });

  describe("reviews", () => {
    it("validates the query", () => {
      expect(parseReviewsQuery(sp("q=2026-10&page=2"))).toEqual({ q: "2026-10", page: 2 });
      for (const bad of ["page=0", "q=%3Cb%3E", `q=${"a".repeat(21)}`])
        expect(parseReviewsQuery(sp(bad))).toBeNull();
    });
    it("lists reviews and finds today's pending", async () => {
      const m = await loadReviewList(envOf(w, "owner"), { page: 1 });
      expect(m.rows.map((r) => r.d)).toEqual([D]);
      expect(m.rows[0]).toMatchObject({ kindText: "Complete", read: false });
      expect(m.pending).toBe(true);
      expect((await loadReviewList(envOf(w, "owner"), { q: "2026-10", page: 1 })).rows.length).toBe(
        1,
      );
      expect((await loadReviewList(envOf(w, "owner"), { q: "2025", page: 1 })).state).toBe("empty");
    });
    it("the Owner and a granted user get the stored HTML; Mark as read is Owner-only", async () => {
      for (const who of UNMASKED) {
        const m = await loadReviewPage(envOf(w, who), D);
        expect(m?.html).toContain("ZZUP");
        expect(m?.maskedView).toBeNull();
        expect(m?.canMarkRead).toBe(who === "owner");
      }
    });
    it("masked users never get the HTML, only the masked view", async () => {
      for (const who of MASKED) {
        const m = await loadReviewPage(envOf(w, who), D);
        expect(m?.html).toBeNull();
        expect(m?.unavailable).toBe(false);
        expect(m?.canMarkRead).toBe(false);
        noLeak(m);
        expect(JSON.stringify(m)).not.toMatch(priceish);
      }
      expect(await loadReviewPage(envOf(w, "viewer"), "not-a-date")).toBeNull();
    });
  });

  describe("knowledge", () => {
    it("validates the query", () => {
      expect(parseKnowledgeQuery(sp("type=lesson&family=F1&grade=L2&q=zz"))).toMatchObject({
        type: "lesson",
        family: "F1",
      });
      for (const bad of ["type=nope", "family=F9", "grade=L9", `q=${"a".repeat(61)}`]) {
        expect(parseKnowledgeQuery(sp(bad))).toBeNull();
      }
    });
    it("the Owner sees the documents and the plan as stored", async () => {
      const m = await loadKnowledge(envOf(w, "owner"), {});
      expect(m.state).toBe("ok");
      expect(m.lessons.map((l) => l.id)).toEqual(["L-1"]);
      expect(JSON.stringify(m.documents)).toContain("ZZUP");
      expect(JSON.stringify(m.plan)).toContain("ZZUP");
      expect((await loadKnowledge(envOf(w, "owner"), { type: "family" })).documents).toEqual([]);
    });
    it("masked users get rules-only text: no code in documents or the plan", async () => {
      for (const who of MASKED) {
        const m = await loadKnowledge(envOf(w, who), {});
        expect(m.documents.length).toBe(1);
        expect(m.plan?.items.length).toBe(1);
        noLeak(m);
        // The path is a file name and is masked too.
        expect(JSON.stringify(m)).not.toContain("L-ZZUP");
      }
    });
  });

  describe("health, usage, settings, shell", () => {
    it("health shows n / 9 to everyone and the fix details to the Owner only", async () => {
      const own = await loadHealth(envOf(w, "owner"), {});
      expect(own.total).toBe(9);
      expect(own.headline).toBe(`${own.healthy} / 9 healthy`);
      expect(own.details).toBe(true);
      expect(own.components.some((c) => c.items.length > 0)).toBe(true);
      for (const who of ["editor", "viewer"] as Who[]) {
        const m = await loadHealth(envOf(w, who), {});
        expect(m.details).toBe(false);
        expect(m.components.every((c) => c.items.length === 0)).toBe(true);
        expect(m.healthy).toBe(own.healthy);
        noLeak(m);
      }
    });
    it("usage is Owner-only and holds the LLM section", async () => {
      for (const who of ["editor", "viewer", "granted"] as Who[]) {
        expect(await loadUsage(envOf(w, who), {})).toBeNull();
      }
      const m = await loadUsage(envOf(w, "owner"), {});
      expect(m?.meters.length).toBeGreaterThan(0);
      expect(m?.llm.rows).toEqual([
        {
          role: "narrator",
          provider: "mock",
          calls: 1,
          cached: 0,
          rulesOnly: 0,
          tokensIn: 10,
          tokensOut: 20,
        },
      ]);
    });
    it("settings are the caller's own; the sharing trail is Owner-only", async () => {
      const own = await loadSettings(envOf(w, "owner"));
      expect(own.sharing).toEqual({ acknowledgements: 0, lastAt: null });
      expect(own.markets.map((x) => x.code)).toContain("AU");
      for (const who of ["editor", "viewer"] as Who[]) {
        const m = await loadSettings(envOf(w, who));
        expect(m.sharing).toBeNull();
        expect(m.preferences.default_market).toBe("AU");
      }
    });
    it("the shell has the bell count, the top tier and the mode banner", async () => {
      const m = await loadShell(envOf(w, "viewer"));
      expect(m.masked).toBe(true);
      expect(m.market?.code).toBe("AU");
      expect(m.bell.count).toBe(1);
      expect(m.bell.topTier).toBe("P1");
    });
  });
});
