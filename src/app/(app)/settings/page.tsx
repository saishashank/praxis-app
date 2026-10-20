// Settings > Personal (UX-110, UXN-160, ROL-102a). Every role may open it and change its OWN
// preferences: time format, how P1/P2 alerts are delivered and quiet hours. P0 is fixed. Theme and
// motion are on Appearance, the opening market on Region & markets.
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { getQuietHours } from "@/lib/alerts/api";
import { getPreferences } from "@/lib/preferences/service";
import { QuietHoursForm } from "./QuietHoursForm";
import { SettingsForm } from "./SettingsForm";
import { Select, SettingsFrame } from "./SettingsNav";
import { setQuietHoursAction, updatePreferencesAction } from "./actions";

export const dynamic = "force-dynamic";

const DELIVERY: Array<[string, string]> = [
  ["immediate", "Immediately"],
  ["digest", "In the digest"],
];

export default async function SettingsPage() {
  const user = await requireUser("own_preferences", "/settings");
  const db = authDb();
  const prefs = await getPreferences(db, user.id);
  const quiet = await getQuietHours(db, user.id).catch(() => null);
  return (
    <SettingsFrame
      tab="personal"
      role={user.role}
      intro="Personal preferences. They apply to your account only."
    >
      <SettingsForm action={updatePreferencesAction}>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Time</legend>
          <Select
            name="time_format"
            label="Time format"
            value={prefs.time_format}
            options={[
              ["24h", "24-hour (13:30)"],
              ["12h", "12-hour (1:30 pm)"],
            ]}
          />
          <p className="text-xs text-text-muted">
            Which clock the times use (Melbourne or exchange time) is on Region &amp; markets.
          </p>
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
      <Card title="Quiet hours" headingLevel={2}>
        <QuietHoursForm
          action={setQuietHoursAction}
          start={quiet?.start ?? null}
          end={quiet?.end ?? null}
        />
      </Card>
    </SettingsFrame>
  );
}
