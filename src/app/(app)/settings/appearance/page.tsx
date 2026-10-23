// Settings > Appearance (UXN-280, UXN-281). Six themes and the Motion switch, stored per user so they
// follow the user across devices. The gain/loss colour option is not offered: the Owner has not yet
// chosen to allow plain red and green (D-128 decision 6); the colour-blind-safe pair is the only one.
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { getPreferences } from "@/lib/preferences/service";
import { SettingsForm } from "../SettingsForm";
import { Select, SettingsFrame } from "../SettingsNav";
import { updateAppearanceAction } from "../actions";
import { ThemePicker } from "./ThemePicker";

export const dynamic = "force-dynamic";

export default async function AppearancePage() {
  const user = await requireUser("own_preferences", "/settings/appearance");
  const prefs = await getPreferences(authDb(), user.id);
  return (
    <SettingsFrame
      title="Appearance"
      intro="How the app looks for you. It applies to your account on every device."
    >
      <SettingsForm action={updateAppearanceAction}>
        <ThemePicker value={prefs.theme} />
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Motion</legend>
          <Select
            name="motion"
            label="Animation"
            value={prefs.motion}
            options={[
              ["on", "On"],
              ["off", "Off (no animation)"],
            ]}
            hint="Off stops non-essential animation. It is also off automatically when your device asks for reduced motion."
          />
        </fieldset>
        <p className="text-sm text-text-muted">
          Gains and losses use colour-blind-safe teal and orange, and always also show a ▲ or ▼ and
          a sign.
        </p>
      </SettingsForm>
    </SettingsFrame>
  );
}
