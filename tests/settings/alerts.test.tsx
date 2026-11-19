// M21 C3 (EML-043, D-1226; UXN-322; AT-77, AT-82): Settings > Alerts shows the stop-hit row (default off,
// from config `stop_hit_email_default`), the action stores it through the preferences service, and the
// My alerts loader offers Unmute only on an alert the user muted.
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { KEY } from "../auth/helpers";
import { envOf, fullWorld, D, type World } from "../loaders/world";
import { alertIdOf, insertTransition } from "@/lib/alerts/pick/store";
import { setConfig } from "@/lib/config/store";
import { loadAlertSettings, loadMyAlerts } from "@/lib/ui/loaders/pickAlerts";
import { UnmuteButton } from "@/app/(app)/alerts/MuteButton";
import { ALERT_SETTING_WORDS } from "@/app/(app)/picks/text";

const hoist = vi.hoisted(() => ({
  user: { id: 1, role: "owner" },
  main: null as unknown,
  auth: null as unknown,
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => hoist.user) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => hoist.main, authDb: () => hoist.auth }));

import { updateAlertSettingsAction } from "@/app/(app)/settings/alerts/actions";
import { muteAlertAction, unmuteAlertAction } from "@/app/(app)/alerts/actions";

afterAll(cleanupTempDbs);
afterEach(cleanup);

let w: World;
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeAll(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  w = await fullWorld();
  hoist.main = w.main;
  hoist.auth = w.auth;
  hoist.user = { id: w.ids.owner, role: "owner" };
});

describe("Settings > Alerts: the stop-hit e-mail row (EML-043)", () => {
  it("is Off while nothing is chosen and config says off (AT-77: a fresh configuration)", async () => {
    const s = await loadAlertSettings(envOf(w, "owner"));
    expect(s.stopHitEmails).toBe("off");
    expect(s.stopHitIsDefault).toBe(true);
  });

  it("the row is on the page with its words and says it is information only", () => {
    expect(ALERT_SETTING_WORDS.stopHit).toBe(
      "E-mail me when a pick I was alerted on trades under its stop (delayed)",
    );
    const page = readFileSync("src/app/(app)/settings/alerts/page.tsx", "utf8");
    expect(page).toContain('name="stop_hit_emails"');
    expect(page).toContain("ALERT_SETTING_WORDS.stopHit");
    expect(page).toContain("Information only");
  });

  it("the config default on applies until the user chooses; a stored choice wins", async () => {
    await setConfig(w.main, {
      key: "stop_hit_email_default",
      value: "on",
      userId: null,
      reason: "test",
      now: "2026-11-01T00:00:00.000Z",
    });
    expect(await loadAlertSettings(envOf(w, "owner"))).toMatchObject({
      stopHitEmails: "on",
      stopHitIsDefault: true,
    });
    expect(await updateAlertSettingsAction(form({ stop_hit_emails: "off" }))).toEqual({ ok: true });
    expect(await loadAlertSettings(envOf(w, "owner"))).toMatchObject({
      stopHitEmails: "off",
      stopHitIsDefault: false,
    });
    expect(await updateAlertSettingsAction(form({ stop_hit_emails: "on" }))).toEqual({ ok: true });
    expect((await loadAlertSettings(envOf(w, "owner"))).stopHitEmails).toBe("on");
    expect(await updateAlertSettingsAction(form({ stop_hit_emails: "maybe" }))).toEqual({
      error: "invalid",
    });
  });
});

describe("My alerts: the Unmute offer (UXN-322)", () => {
  it("only an alert the user muted can be unmuted; every other clear is final", async () => {
    const base = {
      userId: String(w.ids.owner),
      market: "AU",
      pickD: D,
      profile: "balanced",
      sessionD: "2026-10-20",
      limitMicro: 10_050_000n,
      stopMicro: 9_200_000n,
      at: "2026-10-20T01:00:00.000Z",
      hitMicro: null,
      quoteAt: null,
    };
    for (const [rank, reason] of [
      [5, "muted"],
      [6, "below_stop"],
    ] as const) {
      const alertId = alertIdOf(String(w.ids.owner), "AU", D, "balanced", rank);
      const row = { ...base, alertId, rank, code: `ZZ${rank}` };
      await insertTransition(w.main, { ...row, seq: 1, state: "armed", clearReason: null });
      await insertTransition(w.main, { ...row, seq: 2, state: "cleared", clearReason: reason });
    }
    const m = await loadMyAlerts(envOf(w, "owner"));
    const byCode = (c: string) => m.rows.find((r) => r.stock === c)!;
    expect(byCode("ZZ5")).toMatchObject({ canMute: false, canUnmute: true, reason: "muted" });
    expect(byCode("ZZ6")).toMatchObject({ canMute: false, canUnmute: false });
  });

  it("the chip says Muted and offers Unmute", () => {
    render(
      <UnmuteButton action={async () => ({ ok: true })} alertId={"a".repeat(64)} stock="ZZ5" />,
    );
    expect(screen.getByTestId("muted-chip").textContent).toBe("Muted");
    expect(screen.getByRole("button", { name: "Unmute the alert for ZZ5" })).toBeTruthy();
  });
});

describe("unmuteAlertAction (UXN-322, D-1207)", () => {
  it("mute then unmute through the actions: own alert, appended armed row; refusals say why", async () => {
    // a pick that is on the current list today (the newest list, valid far ahead)
    await w.main.execute({
      sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
              reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
              risk_micro, factors_json, based_on_json, pick_sha, created_at)
            VALUES ('AU', '2026-11-16', 'balanced', 9, 'ZZ9', 'F1', 'U1', 'F1.v1', 'sig-ZZ9', 'Synthetic ZZ9',
              10000000, 10000000, '2099-01-01', 9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?,
              '2026-11-16T07:00:00.000Z')`,
      args: ["a".repeat(64)],
    });
    const alertId = alertIdOf(String(w.ids.owner), "AU", "2026-11-16", "balanced", 9);
    await insertTransition(w.main, {
      alertId,
      seq: 1,
      userId: String(w.ids.owner),
      market: "AU",
      pickD: "2026-11-16",
      profile: "balanced",
      rank: 9,
      code: "ZZ9",
      sessionD: "2026-11-17",
      state: "armed",
      limitMicro: 10_000_000n,
      stopMicro: 9_000_000n,
      at: "2026-11-17T00:00:00.000Z",
      hitMicro: null,
      quoteAt: null,
      clearReason: null,
    });
    hoist.user = { id: w.ids.owner, role: "owner" };
    expect(await unmuteAlertAction(form({ alert_id: alertId }))).toEqual({ error: "invalid" }); // armed
    expect(await unmuteAlertAction(form({ alert_id: "nope" }))).toEqual({ error: "invalid" });
    expect(await muteAlertAction(form({ alert_id: alertId }))).toEqual({ ok: true });
    hoist.user = { id: w.ids.editor, role: "editor" };
    expect(await unmuteAlertAction(form({ alert_id: alertId }))).toEqual({ error: "invalid" }); // not theirs
    hoist.user = { id: w.ids.owner, role: "owner" };
    await updateAlertSettingsAction(form({ pick_alerts: "off" }));
    expect(await unmuteAlertAction(form({ alert_id: alertId }))).toEqual({ error: "alerts_off" });
    await updateAlertSettingsAction(form({ pick_alerts: "on" }));
    expect(await unmuteAlertAction(form({ alert_id: alertId }))).toEqual({ ok: true });
    const rows = await w.main.execute({
      sql: "SELECT state, clear_reason FROM pick_alert WHERE alert_id = ? ORDER BY seq",
      args: [alertId],
    });
    expect(rows.rows.map((r) => `${r.state}:${r.clear_reason}`)).toEqual([
      "armed:null",
      "cleared:muted",
      "armed:null",
    ]);
    // Undo of the unmute is a mute again: seq 4
    expect(await muteAlertAction(form({ alert_id: alertId }))).toEqual({ ok: true });
    expect(
      Number(
        (
          await w.main.execute({
            sql: "SELECT MAX(seq) AS n FROM pick_alert WHERE alert_id = ?",
            args: [alertId],
          })
        ).rows[0].n,
      ),
    ).toBe(4);
  });
});
