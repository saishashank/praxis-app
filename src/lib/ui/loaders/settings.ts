// Settings loader: Personal, Appearance and Region & markets (UX-110, UX-112, UXN-160, UXN-280..282;
// docs/M7_design.md 3 rows 30..32; D-136 draft). Every role reads its OWN preferences only (the user id
// is the session user's, never a parameter). Owner-only fields (the sharing acknowledgement trail) are
// absent for Editors and Viewers.
import { getQuietHours, type QuietHours } from "@/lib/alerts/api";
import {
  getPreferences,
  SELECTABLE_MARKETS,
  THEMES,
  type Preferences,
} from "@/lib/preferences/service";
import { type LoaderEnv, type LoaderState } from "./shell";

export type SettingsModel = {
  state: LoaderState;
  preferences: Preferences;
  themes: readonly string[];
  quietHours: QuietHours | null;
  markets: Array<{ code: string; mode: string; currency: string; selectable: boolean }>;
  /** Owner only; null for everyone else. */
  sharing: { acknowledgements: number; lastAt: string | null } | null;
};

export async function loadSettings(env: LoaderEnv): Promise<SettingsModel> {
  const preferences = await getPreferences(env.auth, env.user.id);
  const quietHours = await getQuietHours(env.auth, env.user.id);
  const m = await env.main.execute({
    sql: "SELECT code, mode, currency FROM market ORDER BY code",
    args: [],
  });
  const markets = m.rows.map((x) => ({
    code: String(x.code),
    mode: String(x.mode),
    currency: String(x.currency),
    selectable: (SELECTABLE_MARKETS as readonly string[]).includes(String(x.code)),
  }));
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
