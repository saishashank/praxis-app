// Settings > Personal (UX-110, UXN-280, ROL-102a). Every role may open it and change its OWN
// preferences. Carries the fixed SEC-016 footer and the ROL-106 disclaimer.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import {
  getPreferences,
  SELECTABLE_MARKETS,
  THEMES,
  type Preferences,
} from "@/lib/preferences/service";
import { SettingsForm } from "./SettingsForm";
import { updatePreferencesAction } from "./actions";

export const dynamic = "force-dynamic";

const THEME_LABEL: Record<(typeof THEMES)[number], string> = {
  dark: "Dark (default)",
  light: "Light",
  system: "Match device",
  midnight: "Midnight (true black)",
  dim: "Dim",
  high_contrast: "High contrast",
};

function Select({
  name,
  label,
  value,
  options,
}: {
  name: keyof Preferences;
  label: string;
  value: string;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select name={name} defaultValue={value} className="rounded border px-2 py-1">
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

const DELIVERY: Array<[string, string]> = [
  ["immediate", "Immediately"],
  ["digest", "In the digest"],
];

export default async function SettingsPage() {
  const user = await requireUser("own_preferences", "/settings");
  const prefs = await getPreferences(authDb(), user.id);
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <span className="rounded border px-2 py-0.5 text-xs" aria-label="Your role">
          {user.role}
        </span>
      </header>
      <p className="text-sm text-text-muted">
        Personal preferences. They apply to your account only.
      </p>
      <SettingsForm action={updatePreferencesAction}>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Appearance</legend>
          <Select
            name="theme"
            label="Theme"
            value={prefs.theme}
            options={THEMES.map((t) => [t, THEME_LABEL[t]])}
          />
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Region and time</legend>
          <Select
            name="default_market"
            label="Default market"
            value={prefs.default_market}
            options={SELECTABLE_MARKETS.map((m) => [m, m])}
          />
          <Select
            name="time_format"
            label="Time format"
            value={prefs.time_format}
            options={[
              ["24h", "24-hour (13:30)"],
              ["12h", "12-hour (1:30 pm)"],
            ]}
          />
          <p className="text-xs text-text-muted">Times are always shown in Melbourne time.</p>
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Alerts</legend>
          <p className="text-sm">
            P0 alerts are always delivered immediately. They cannot be turned off or delayed.
          </p>
          <Select name="alert_p1" label="P1 alerts" value={prefs.alert_p1} options={DELIVERY} />
          <Select name="alert_p2" label="P2 alerts" value={prefs.alert_p2} options={DELIVERY} />
        </fieldset>
      </SettingsForm>
      <p className="text-xs">
        Emails from this system never ask for keys or passwords. Sign in and do rotations only via
        your own bookmark.
      </p>
      <nav>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </nav>
      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}
