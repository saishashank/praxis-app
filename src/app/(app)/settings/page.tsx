// Settings (UXR-027, UXR-003, UXR-042, UXR-043, UXR-046, UXR-055; UX-110, UXN-160, UXN-280, UXN-282,
// ROL-102a). One page of grouped value rows (current value on the right); a row opens a sheet/drawer
// with one Save (SettingsRows). Without JavaScript each row is a link to its detail page. Every role
// may change its OWN preferences. Account carries identity, role and a full-width Sign out (UXR-004).
// Destructive actions are neutral in the list; red appears only in the confirm sheet. P0 alerts are fixed.
import { Avatar } from "@/components/shell/GearMenu";
import { ValueRow } from "@/components/ui/ValueRow";
import { requireUser } from "@/lib/auth/guard";
import { signOutAction } from "@/lib/auth/actions";
import { authDb } from "@/lib/db/client";
import { getQuietHours } from "@/lib/alerts/api";
import { getPreferences } from "@/lib/preferences/service";
import type { CurrentUser } from "@/lib/auth/session";
import { loadSettings } from "@/lib/ui/loaders/settings";
import { envFor } from "@/lib/ui/loaders/shell";
import { melbourneDate } from "@/lib/view/active";
import { marketRows, readProfiles, readSharedMarkets, type MarketProfiles } from "./region";
import { AboutIcon, ClockIcon, GlobeIcon, PaletteIcon, UserIcon } from "./GroupIcons";
import { SettingsFrame } from "./SettingsNav";
import { MotionRow, ThemeRow } from "./AppearanceRows";
import {
  Group,
  InfoRow,
  QuietRow,
  ChoiceRow,
  SettingsRoot,
  SignOutEverywhereRow,
} from "./SettingsRows";
import { DELIVERY, TIME_FORMAT, TIMES_IN } from "./options";
import notices from "@/generated/notices.json";
import {
  setQuietHoursAction,
  signOutEverywhereSelfAction,
  updateAppearanceAction,
  updatePreferencesAction,
  updateRegionAction,
} from "./actions";

export const dynamic = "force-dynamic";

const ROLE_NAME: Record<string, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

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
  const markets = await choosableMarkets(user).catch((): Array<[string, string]> => []);
  if (!markets.some(([k]) => k === prefs.default_market)) {
    markets.unshift([prefs.default_market, prefs.default_market]);
  }
  const role = ROLE_NAME[user.role] ?? user.role;
  const choices = (opts: Array<[string, string]>) =>
    opts.map(([value, label]) => ({ value, label }));
  const build = (process.env.APP_COMMIT ?? "").slice(0, 7);
  return (
    <SettingsFrame intro="Your own preferences. They apply to your account on every device.">
      <SettingsRoot>
        <Group id="account" title="Account" hue="home" icon={<UserIcon />}>
          <div className="flex flex-wrap items-center gap-4 py-4">
            <Avatar account={{ email: user.email, name: user.name }} role={user.role} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate font-medium">{user.email}</p>
              <p className="m-0 text-sm text-text-muted">
                Role: <span aria-label="Your role">{role}</span>
              </p>
            </div>
          </div>
          <form action={signOutAction} className="pb-4">
            <button
              type="submit"
              className="ui-btn-secondary min-h-11 w-full rounded-md border border-border px-4 text-sm font-semibold"
            >
              Sign out
            </button>
          </form>
          {user.role === "owner" ? (
            <SignOutEverywhereRow
              action={signOutEverywhereSelfAction}
              href="/settings/sign-out-everywhere"
            />
          ) : null}
        </Group>

        <Group id="appearance" title="Appearance" hue="strategies" icon={<PaletteIcon />}>
          <ThemeRow current={prefs.theme} action={updateAppearanceAction} />
          <MotionRow current={prefs.motion} action={updateAppearanceAction} />
        </Group>

        <Group id="time" title="Time and alerts" hue="picks" icon={<ClockIcon />}>
          <ChoiceRow
            label="Time format"
            field="time_format"
            current={prefs.time_format}
            choices={choices(TIME_FORMAT)}
            href="/settings/time"
            action={updatePreferencesAction}
          />
          <ChoiceRow
            label="P1 alerts"
            field="alert_p1"
            current={prefs.alert_p1}
            choices={choices(DELIVERY)}
            href="/settings/time"
            description="P0 alerts are always delivered immediately. They cannot be turned off or delayed."
            action={updatePreferencesAction}
          />
          <ChoiceRow
            label="P2 alerts"
            field="alert_p2"
            current={prefs.alert_p2}
            choices={choices(DELIVERY)}
            href="/settings/time"
            description="P0 alerts are always delivered immediately. They cannot be turned off or delayed."
            action={updatePreferencesAction}
          />
          <QuietRow
            start={quiet?.start ?? null}
            end={quiet?.end ?? null}
            action={setQuietHoursAction}
            href="/settings/quiet-hours"
          />
        </Group>

        <Group id="region" title="Region and markets" hue="market" icon={<GlobeIcon />}>
          <ChoiceRow
            label="Open the app in"
            field="default_market"
            current={prefs.default_market}
            choices={choices(markets)}
            href="/settings/region"
            description="Only active markets can be chosen. The full list is under Markets."
            action={updateRegionAction}
          />
          <ChoiceRow
            label="Show times in"
            field="times_in"
            current={prefs.times_in}
            choices={choices(TIMES_IN)}
            href="/settings/region"
            action={updateRegionAction}
          />
          <ValueRow label="Markets" value="Exchanges, hours, status" href="/settings/region" />
        </Group>

        <Group id="about" title="About" hue="reviews" icon={<AboutIcon />}>
          <ValueRow
            label="Version"
            value={<span className="font-mono">{build || "—"}</span>}
            href="/settings/about"
          />
          <InfoRow
            label="Fonts and attribution"
            value="Inter, JetBrains Mono"
            href="/settings/about"
            title="Fonts and attribution"
          >
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {notices.fonts.map((f) => (
                <li key={f.name}>
                  {f.name}: {f.license}. {f.note}
                </li>
              ))}
              {notices.attributions.map((a) => (
                <li key={a.name}>
                  {a.text}{" "}
                  <a href={a.href} rel="noopener noreferrer" className="text-accent underline">
                    tradingview.com
                  </a>
                </li>
              ))}
            </ul>
          </InfoRow>
          <ValueRow
            label="Licences"
            value={`${notices.packages.length} packages`}
            href="/settings/about#licences"
          />
        </Group>
      </SettingsRoot>
    </SettingsFrame>
  );
}
