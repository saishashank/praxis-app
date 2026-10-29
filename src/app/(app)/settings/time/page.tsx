// Settings > Time and alerts (no-JS detail page for the rows on /settings, UXR-027): time format and
// P1/P2 delivery in one form with one Save. P0 is not a setting.
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { getPreferences } from "@/lib/preferences/service";
import { SettingsForm } from "../SettingsForm";
import { Select, SettingsFrame } from "../SettingsNav";
import { updatePreferencesAction } from "../actions";
import { DELIVERY, TIME_FORMAT } from "../options";

export const dynamic = "force-dynamic";

export default async function TimePage() {
  const user = await requireUser("own_preferences", "/settings/time");
  const prefs = await getPreferences(authDb(), user.id);
  return (
    <SettingsFrame
      title="Time and alerts"
      intro="How times and alerts are shown to you. Quiet hours are on their own page."
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
    </SettingsFrame>
  );
}
