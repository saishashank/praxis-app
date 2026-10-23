// Settings (UXR-027; UX-110, UXN-160, UXN-280, UXN-282, ROL-102a). One page, grouped rows, each
// showing its current value; opening a row shows its form in place with one Save. Every role may open
// it and change its OWN preferences. Account carries the identity and a full-width Sign out (UXR-004).
// P0 alerts are fixed. The markets table and the licence list stay on their detail pages.
import { Avatar } from "@/components/shell/GearMenu";
import { requireUser } from "@/lib/auth/guard";
import { signOutAction } from "@/lib/auth/actions";
import { authDb } from "@/lib/db/client";
import { getQuietHours } from "@/lib/alerts/api";
import { getPreferences } from "@/lib/preferences/service";
import type { CurrentUser } from "@/lib/auth/session";
import { loadSettings } from "@/lib/ui/loaders/settings";
import { envFor } from "@/lib/ui/loaders/shell";
import { melbourneDate } from "@/lib/view/active";
import { QuietHoursForm } from "./QuietHoursForm";
import { marketRows, readProfiles, readSharedMarkets, type MarketProfiles } from "./region";
import { SettingsForm } from "./SettingsForm";
import { EditRow, LinkRow, Select, SettingsFrame, SettingsGroup } from "./SettingsNav";
import { ThemePicker, THEME_LABEL } from "./appearance/ThemePicker";
import {
  setQuietHoursAction,
  updateAppearanceAction,
  updatePreferencesAction,
  updateRegionAction,
} from "./actions";

export const dynamic = "force-dynamic";

const ROLE_NAME: Record<string, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

const DELIVERY: Array<[string, string]> = [
  ["immediate", "Immediately"],
  ["digest", "In the digest"],
];
const TIME_FORMAT: Array<[string, string]> = [
  ["24h", "24-hour (13:30)"],
  ["12h", "12-hour (1:30 pm)"],
];
const TIMES_IN: Array<[string, string]> = [
  ["melbourne", "Melbourne time"],
  ["exchange", "Exchange-local time"],
];
const MOTION: Array<[string, string]> = [
  ["on", "On"],
  ["off", "Off (no animation)"],
];

const labelOf = (opts: Array<[string, string]>, v: string): string =>
  opts.find(([k]) => k === v)?.[1] ?? v;

/** The markets this user may open the app in (same rules as Settings › Region & markets). */
async function choosableMarkets(user: CurrentUser): Promise<Array<[string, string]>> {
  const env = await envFor({ id: user.id, role: user.role });
  const model = await loadSettings(env);
  const [profiles, shared] = await Promise.all([
    readProfiles(env.main).catch((): MarketProfiles => ({})),
    readSharedMarkets(env.auth).catch(() => new Set<string>()),
  ]);
  const today = melbourneDate(env.now.toISOString()) ?? "";
  return marketRows(model, profiles, shared, user.role === "owner", today)
    .filter((r) => r.selectable)
    .map((r): [string, string] => [r.code, `${r.code} (${r.exchange})`]);
}

export default async function SettingsPage() {
  const user = await requireUser("own_preferences", "/settings");
  const db = authDb();
  const prefs = await getPreferences(db, user.id);
  const quiet = await getQuietHours(db, user.id).catch(() => null);
  const quietText = quiet?.start && quiet?.end ? `${quiet.start}–${quiet.end}` : "Off";
  const markets = await choosableMarkets(user).catch((): Array<[string, string]> => []);
  if (!markets.some(([k]) => k === prefs.default_market)) {
    markets.unshift([prefs.default_market, prefs.default_market]);
  }
  const role = ROLE_NAME[user.role] ?? user.role;
  return (
    <SettingsFrame intro="Your own preferences. They apply to your account on every device.">
      <SettingsGroup id="account" title="Account">
        <div className="flex flex-wrap items-center gap-4 px-4 py-4">
          <Avatar account={{ email: user.email, name: user.name }} role={user.role} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate font-medium">{user.email}</p>
            <p className="m-0 text-sm text-text-muted">
              Role: <span aria-label="Your role">{role}</span>
            </p>
          </div>
        </div>
        <form action={signOutAction} className="px-4 py-4">
          <button
            type="submit"
            className="ui-btn-secondary min-h-11 w-full rounded-md border border-border px-4 text-sm font-semibold"
          >
            Sign out
          </button>
        </form>
      </SettingsGroup>

      <SettingsGroup id="appearance" title="Appearance">
        <EditRow
          name="Look"
          values={[
            { label: "Theme", value: THEME_LABEL[prefs.theme] ?? prefs.theme },
            { label: "Animation", value: labelOf(MOTION, prefs.motion) },
          ]}
        >
          <SettingsForm action={updateAppearanceAction}>
            <ThemePicker value={prefs.theme} />
            <Select
              name="motion"
              label="Animation"
              value={prefs.motion}
              options={MOTION}
              hint="Off stops non-essential animation. It is also off automatically when your device asks for reduced motion."
            />
            <p className="m-0 text-xs text-text-muted">
              Gains and losses use colour-blind-safe teal and orange, and always also show a ▲ or ▼
              and a sign.
            </p>
          </SettingsForm>
        </EditRow>
      </SettingsGroup>

      <SettingsGroup id="time" title="Time and alerts">
        <EditRow
          name="Time and alerts"
          values={[
            { label: "Time format", value: labelOf(TIME_FORMAT, prefs.time_format) },
            { label: "P1 alerts", value: labelOf(DELIVERY, prefs.alert_p1) },
            { label: "P2 alerts", value: labelOf(DELIVERY, prefs.alert_p2) },
          ]}
        >
          <SettingsForm action={updatePreferencesAction}>
            <Select
              name="time_format"
              label="Time format"
              value={prefs.time_format}
              options={TIME_FORMAT}
            />
            <p className="m-0 text-sm">
              P0 alerts are always delivered immediately. They cannot be turned off or delayed.
            </p>
            <Select name="alert_p1" label="P1 alerts" value={prefs.alert_p1} options={DELIVERY} />
            <Select name="alert_p2" label="P2 alerts" value={prefs.alert_p2} options={DELIVERY} />
          </SettingsForm>
        </EditRow>
        <EditRow name="Quiet hours" values={[{ label: "Melbourne time", value: quietText }]}>
          <QuietHoursForm
            action={setQuietHoursAction}
            start={quiet?.start ?? null}
            end={quiet?.end ?? null}
          />
        </EditRow>
      </SettingsGroup>

      <SettingsGroup id="region" title="Region and markets">
        <EditRow
          name="Region"
          values={[
            { label: "Open the app in", value: prefs.default_market },
            { label: "Show times in", value: labelOf(TIMES_IN, prefs.times_in) },
          ]}
        >
          <SettingsForm action={updateRegionAction}>
            <Select
              name="default_market"
              label="Open the app in"
              value={prefs.default_market}
              options={markets}
              hint="Only active markets can be chosen. The full list is under Markets."
            />
            <Select
              name="times_in"
              label="Show times in"
              value={prefs.times_in}
              options={TIMES_IN}
            />
          </SettingsForm>
        </EditRow>
        <LinkRow
          name="Markets"
          href="/settings/region"
          hint="Exchanges, currencies, hours and status"
        />
      </SettingsGroup>

      <SettingsGroup id="about" title="About">
        <LinkRow name="About Praxis" href="/settings/about" hint="Version, fonts and licences" />
      </SettingsGroup>
    </SettingsFrame>
  );
}
