// Settings loader: Personal, Appearance and Region & markets (UX-110, UX-112, UXN-160, UXN-280..282;
// docs/M7_design.md 3 rows 30..32; D-136 draft). Every role reads its OWN preferences only (the user id
// is the session user's, never a parameter). Owner-only fields (the sharing acknowledgement trail) are
// absent for Editors and Viewers.
import { getQuietHours, type QuietHours } from "@/lib/alerts/api";
import { getPreferences, THEMES, type Preferences } from "@/lib/preferences/service";
import { checklist, type ChecklistItem, type ChecklistStep } from "@/lib/market/checklist";
import { builtMarkets, loadProfile } from "@/lib/market/profile";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { loadProjectionReport, type MetricVerdict } from "@/lib/usage/projection";
import { type LoaderEnv, type LoaderState } from "./shell";

export type SettingsModel = {
  state: LoaderState;
  preferences: Preferences;
  themes: readonly string[];
  quietHours: QuietHours | null;
  /** Owner: every profile row. Editor and Viewer: the enabled markets only (D-997). */
  markets: Array<{
    code: string;
    mode: string;
    currency: string;
    enabled: boolean;
    selectable: boolean;
  }>;
  /** Owner only; null for everyone else. */
  sharing: { acknowledgements: number; lastAt: string | null } | null;
};

export async function loadSettings(env: LoaderEnv): Promise<SettingsModel> {
  const preferences = await getPreferences(env.auth, env.user.id);
  const quietHours = await getQuietHours(env.auth, env.user.id);
  const m = await env.main.execute({
    sql: "SELECT code, mode, currency, enabled FROM market ORDER BY code",
    args: [],
  });
  const owner = env.user.role === "owner";
  const markets = m.rows
    .map((x) => ({
      code: String(x.code),
      mode: String(x.mode),
      currency: String(x.currency),
      enabled: Number(x.enabled) === 1,
    }))
    .filter((x) => owner || x.enabled)
    .map((x) => ({ ...x, selectable: x.enabled }));
  let sharing: SettingsModel["sharing"] = null;
  if (env.user.role === "owner") {
    const s = await env.auth.execute({
      sql: "SELECT COUNT(*) AS n, MAX(acknowledged_at) AS last FROM sharing_ack",
      args: [],
    });
    sharing = {
      acknowledgements: Number(s.rows[0]?.n ?? 0), // money-float-ok: SQL count
      lastAt: s.rows[0]?.last ? String(s.rows[0].last) : null,
    };
  }
  return {
    state: markets.length === 0 ? "empty" : "ok",
    preferences,
    themes: THEMES,
    quietHours,
    markets,
    sharing,
  };
}

// ---- the switch-on card of Settings > Region (MKT-111, UXN-312, D-1100; M20 S1) ---------------------------------------

export type SwitchMarketModel = {
  code: string;
  name: string;
  mode: string;
  enabled: boolean;
  /** A full -> off rollback waits for its next-open kill: nothing can be switched meanwhile. */
  rollbackPending: boolean;
  /** The next step the control offers: off -> data_only -> full; null after `full` and during a rollback. */
  next: ChecklistStep | null;
  /** The items of the next step (empty when there is none). */
  items: ChecklistItem[];
  complete: boolean;
  /** The quota projection with AU and the enabled markets (MKT-113); null when it cannot be computed. */
  projection: { fits: boolean; verdicts: MetricVerdict[] } | null;
  projectionNote: string | null;
  /** The rollback button is offered from data_only and full. */
  canRollback: boolean;
};

/**
 * Owner only: one entry per built market other than the home market. Every read is guarded: a market whose checklist
 * cannot be read still shows its mode, with no step offered (the switch itself re-checks everything).
 */
export async function loadMarketSwitch(env: LoaderEnv): Promise<SwitchMarketModel[] | null> {
  if (env.user.role !== "owner") return null;
  let report: Awaited<ReturnType<typeof loadProjectionReport>> | null = null;
  try {
    report = await loadProjectionReport(env.main, env.now);
  } catch {
    report = null;
  }
  const out: SwitchMarketModel[] = [];
  for (const code of builtMarkets()) {
    if (code === HOME_MARKET) continue;
    // rows-ok: primary-key probe of one market row
    const r = await env.main.execute({
      sql: "SELECT mode, enabled, rollback_at FROM market WHERE code = ?",
      args: [code],
    });
    if (r.rows.length !== 1) continue;
    const mode = String(r.rows[0]!.mode);
    const enabled = Number(r.rows[0]!.enabled) === 1;
    const rollbackPending = r.rows[0]!.rollback_at !== null && r.rows[0]!.rollback_at !== undefined;
    const from = enabled ? mode : "off";
    const next: ChecklistStep | null = rollbackPending
      ? null
      : from === "off"
        ? "data_only"
        : from === "data_only"
          ? "full"
          : null;
    let items: ChecklistItem[] = [];
    let complete = false;
    if (next !== null) {
      try {
        const c = await checklist(env.main, code, env.now, { to: next });
        items = c.items;
        complete = c.complete;
      } catch {
        items = [];
      }
    }
    let name = code;
    try {
      name = (await loadProfile(env.main, code)).name;
    } catch {
      /* the code stands in */
    }
    const fit = report?.fitsWith[code] ?? null;
    out.push({
      code,
      name,
      mode: from,
      enabled,
      rollbackPending,
      next,
      items,
      complete,
      projection: fit === null ? null : { fits: fit.fits, verdicts: fit.verdicts },
      projectionNote: report?.markets.find((m) => m.market === code)?.note ?? null,
      canRollback: !rollbackPending && (from === "data_only" || from === "full"),
    });
  }
  return out;
}
