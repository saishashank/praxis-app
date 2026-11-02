// M17 WP8 UI (UXN-301..306, UXN-309/310; AT-62 a/b, AT-65 a/b; D-471..D-478): loaders, actions and
// components for the alert chip, Intraday watch, My alerts, Settings > Alerts, Home rows and masking.
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { KEY } from "../auth/helpers";
import { envOf, fullWorld, D, type World } from "../loaders/world";
import { alertIdOf, insertTransition } from "@/lib/alerts/pick/store";
import { CARD_BANNED } from "@/lib/cortex/phrases";
import {
  catalystWords,
  loadAlertChips,
  loadAlertSettings,
  loadIntraday,
  loadMyAlerts,
  loadAlertHomeFacts,
} from "@/lib/ui/loaders/pickAlerts";
import { AlertChip } from "@/app/(app)/picks/AlertChip";
import { IntradaySection } from "@/app/(app)/picks/IntradaySection";
import * as T from "@/app/(app)/picks/text";

const hoist = vi.hoisted(() => ({
  user: { id: 1, role: "owner" },
  main: null as unknown,
  auth: null as unknown,
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => hoist.user) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => hoist.main, authDb: () => hoist.auth }));

import { muteAlertAction, setAlertsForAllAction } from "@/app/(app)/alerts/actions";
import { setPicksSortAction } from "@/app/(app)/settings/alerts/actions";
import { updateAlertSettingsAction } from "@/app/(app)/settings/alerts/actions";

afterAll(cleanupTempDbs);
afterEach(cleanup);

const SESSION = "2026-10-20";
let w: World;
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function seedAlert(userId: number, rank: number, state: "armed" | "hit" | "cleared") {
  const id = alertIdOf(String(userId), "AU", D, "balanced", rank);
  const base = {
    alertId: id,
    userId: String(userId),
    market: "AU",
    pickD: D,
    profile: "balanced",
    rank,
    code: rank === 1 ? "ZZUP" : "ZZDN",
    sessionD: SESSION,
    limitMicro: 10_050_000n,
    stopMicro: 9_200_000n,
    at: `${SESSION}T01:00:00.000Z`,
    hitMicro: null as bigint | null,
    quoteAt: null as string | null,
    clearReason: null as never,
  };
  await insertTransition(w.main, { ...base, seq: 1, state: "armed" });
  if (state === "hit") {
    await insertTransition(w.main, {
      ...base,
      seq: 2,
      state: "hit",
      hitMicro: 10_000_000n,
      quoteAt: `${SESSION}T03:35:00.000Z`,
    });
  }
  if (state === "cleared") {
    await insertTransition(w.main, {
      ...base,
      seq: 2,
      state: "cleared",
      clearReason: "below_stop",
    });
  }
  return id;
}

async function addCandidate(code: string, mat: number, move: number) {
  await w.main.execute({
    sql: `INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, item_ann_id,
            item_category, materiality, polarity, move_ppm, sector_adj_ppm, gates_json)
          VALUES ('AU', ?, ?, '1030', ?, 'asx', ?, 'results', ?, 'positive', ?, ?, '{}')`,
    args: [SESSION, code, `${SESSION}T00:30:00.000Z`, `a-${code}`, mat, move, move],
  });
}

describe("WP8 loaders", () => {
  let alertA: string;
  beforeAll(async () => {
    vi.stubEnv("PII_HASH_KEY", KEY);
    w = await fullWorld();
    hoist.main = w.main;
    hoist.auth = w.auth;
    hoist.user = { id: w.ids.owner, role: "owner" };
    alertA = await seedAlert(w.ids.owner, 1, "armed");
    await seedAlert(w.ids.owner, 2, "hit");
    await addCandidate("ZZUP", 3, 60000);
    await addCandidate("ZZDN", 2, 90000);
    await addCandidate("ZZOTH", 2, 50000);
  });

  it("chips: the user's own rows; a masked user gets no limit", async () => {
    const own = await loadAlertChips(envOf(w, "owner"), D);
    expect(own.get(`${D}.balanced.1`)?.state).toBe("armed");
    expect(own.get(`${D}.balanced.1`)?.limit).not.toBeNull();
    expect(own.get(`${D}.balanced.2`)?.hitTime).toMatch(/^\d\d:\d\d$/);
    expect((await loadAlertChips(envOf(w, "editor"), D)).size).toBe(0);
    await seedAlert(w.ids.viewer, 1, "armed");
    const masked = await loadAlertChips(envOf(w, "viewer"), D);
    expect(masked.get(`${D}.balanced.1`)?.limit).toBeNull();
  });

  it("intraday: ordered by materiality then move; masked letters and no price", async () => {
    const m = await loadIntraday(envOf(w, "owner"));
    expect(m.rows[0]!.code).toBe("ZZUP");
    expect(m.total).toBe(3);
    expect(m.rows.length + m.more).toBe(3);
    const v = await loadIntraday(envOf(w, "viewer"));
    for (const r of v.rows) {
      expect(r.stock).toMatch(/^Stock [A-Z]$/);
      expect(r.limit).toBeNull();
      expect(r.company).toBeNull();
      expect(r.href).toBeNull();
      expect(r.catalyst).not.toMatch(/ZZ|Zed/);
    }
    expect(v.session).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("My alerts: rows by state; mute writes one cleared 'muted' row, once, own alerts only", async () => {
    const m = await loadMyAlerts(envOf(w, "owner"));
    expect(m.rows.map((r) => r.state).sort()).toEqual(["armed", "hit"]);
    expect(m.rows.find((r) => r.state === "armed")!.canMute).toBe(true);
    expect(m.rows.find((r) => r.state === "hit")!.canMute).toBe(false);
    hoist.user = { id: w.ids.editor, role: "editor" };
    expect(await muteAlertAction(form({ alert_id: alertA }))).toEqual({ error: "invalid" });
    hoist.user = { id: w.ids.owner, role: "owner" };
    expect(await muteAlertAction(form({ alert_id: "nope" }))).toEqual({ error: "invalid" });
    expect(await muteAlertAction(form({ alert_id: alertA }))).toEqual({ ok: true });
    expect(await muteAlertAction(form({ alert_id: alertA }))).toEqual({ error: "invalid" });
    const rows = await w.main.execute({
      sql: "SELECT state, clear_reason FROM pick_alert WHERE alert_id = ? ORDER BY seq",
      args: [alertA],
    });
    expect(rows.rows.map((r) => `${r.state}:${r.clear_reason}`)).toEqual([
      "armed:null",
      "cleared:muted",
    ]);
  });

  it("settings show the EFFECTIVE value: Owner on by default, others off; a choice wins (D-472)", async () => {
    const o = await loadAlertSettings(envOf(w, "owner"));
    expect(o.pickAlerts).toBe("on");
    expect(o.alertsIsDefault).toBe(true);
    expect((await loadAlertSettings(envOf(w, "editor"))).pickAlerts).toBe("off");
    hoist.user = { id: w.ids.owner, role: "owner" };
    expect(
      await updateAlertSettingsAction(
        form({ pick_alerts: "off", cleared_pick_emails: "off", intraday_candidate_emails: "on" }),
      ),
    ).toEqual({ ok: true });
    expect(await loadAlertSettings(envOf(w, "owner"))).toMatchObject({
      pickAlerts: "off",
      clearedEmails: "off",
      candidateEmails: "on",
      alertsIsDefault: false,
    });
    expect(await updateAlertSettingsAction(form({ pick_alerts: "maybe" }))).toEqual({
      error: "invalid",
    });
    expect(await setAlertsForAllAction(form({ pick_alerts: "on" }))).toEqual({ ok: true });
    expect((await loadAlertSettings(envOf(w, "owner"))).pickAlerts).toBe("on");
  });

  it("sort toggle round trip", async () => {
    expect(await setPicksSortAction(form({ picks_sort: "expected_gain" }))).toEqual({ ok: true });
    expect((await loadAlertSettings(envOf(w, "owner"))).picksSort).toBe("expected_gain");
    expect(await setPicksSortAction(form({ picks_sort: "bogus" }))).toEqual({ error: "invalid" });
  });

  it("Home facts: hits, candidates found, candidates held back by the cap (UXN-305)", async () => {
    await w.main.execute({
      sql: "INSERT INTO pick_alert_mail (alert_id, kind, email_key, status, at) VALUES (?, 'pick_candidate', NULL, 'suppressed_cap', ?)",
      args: [`cand:AU:${SESSION}:ZZUP`, `${SESSION}T01:00:00.000Z`],
    });
    const f = await loadAlertHomeFacts(envOf(w, "owner"), `${SESSION}T00:00:00.000Z`);
    expect(f).toEqual({ hits: 1, candidates: 3, suppressed: 1 });
  });
});

describe("WP8 components and wording", () => {
  it("chip words for armed, hit and cleared", () => {
    const base = { alertId: "x", limit: null, hitTime: null, reason: null, session: "s" } as const;
    render(<AlertChip chip={{ ...base, state: "armed" }} />);
    expect(screen.getByTestId("alert-chip").textContent).toBe("Alert armed");
    cleanup();
    render(<AlertChip chip={{ ...base, state: "hit", hitTime: "14:35" }} />);
    expect(screen.getByTestId("alert-chip").textContent).toContain("Hit at 14:35 (delayed quote)");
    cleanup();
    render(<AlertChip chip={{ ...base, state: "cleared", reason: "below_stop" }} />);
    expect(screen.getByTestId("alert-chip").textContent).toContain(
      "Price fell below the stop-loss",
    );
  });

  it("Intraday section: unrated, unvalidated, says delayed, never real-time, no score", () => {
    const row = {
      code: "ZZUP",
      stock: "Stock A",
      company: null,
      foundTime: "10:30",
      catalyst: catalystWords("results", "positive"),
      materiality: 3,
      movePpm: 60000,
      limit: null,
      stop: null,
      quoteTime: "10:50",
      decisionOutcome: null,
      href: null,
    };
    render(
      <IntradaySection
        model={{
          masked: true,
          session: "2026-W43",
          today: true,
          lastScan: "10:30",
          total: 6,
          rows: [row],
          more: 5,
          delayMin: 20,
        }}
      />,
    );
    const text = screen.getByTestId("intraday-section").textContent!;
    expect(text).toContain("Unrated - no history yet");
    expect(text).toContain("Unvalidated");
    expect(text).toMatch(/delayed/);
    expect(text).not.toMatch(/real[- ]?time/i);
    expect(text).not.toMatch(/chance of a net gain|score/i);
    expect(screen.getByTestId("intraday-more").textContent).toBe("5 more not shown.");
  });

  it("empty state names the last scan time", () => {
    render(
      <IntradaySection
        model={{
          masked: false,
          session: null,
          today: true,
          lastScan: "10:30",
          total: 0,
          rows: [],
          more: 0,
          delayMin: 20,
        }}
      />,
    );
    expect(screen.getByTestId("intraday-empty").textContent).toContain("10:30");
  });

  it("new wording passes the banned-terms list and never says real-time", () => {
    const strings = [
      T.TONIGHT_TITLE,
      T.INTRADAY_TITLE,
      T.INTRADAY_EXPLAINER,
      T.INTRADAY_UNRATED,
      T.INTRADAY_UNVALIDATED,
      T.NO_HISTORY,
      T.delayStatement(20),
      T.ALERT_DELAY_HELP,
      ...Object.values(T.ALERT_SETTING_WORDS),
      ...Object.values(T.CLEAR_WORDS),
      ...Object.values(T.MAIL_WORDS),
      ...Object.values(T.SORT_WORDS),
    ];
    for (const s of strings) {
      expect(
        CARD_BANNED.filter((re) => re.test(s)),
        s,
      ).toEqual([]);
      expect(s).not.toMatch(/real[- ]?time/i);
    }
    expect(T.ALERT_DELAY_HELP).toMatch(/delayed/);
  });
});
