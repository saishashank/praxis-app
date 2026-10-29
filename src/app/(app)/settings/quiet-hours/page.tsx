// Settings > Quiet hours (no-JS detail page for the row on /settings, UXR-027, UXN-160).
import { getQuietHours } from "@/lib/alerts/api";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { QuietHoursForm } from "../QuietHoursForm";
import { SettingsFrame } from "../SettingsNav";
import { setQuietHoursAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function QuietHoursPage() {
  const user = await requireUser("own_preferences", "/settings/quiet-hours");
  const quiet = await getQuietHours(authDb(), user.id).catch(() => null);
  return (
    <SettingsFrame title="Quiet hours" intro="A Melbourne-time window for quieter alerts.">
      <QuietHoursForm
        action={setQuietHoursAction}
        start={quiet?.start ?? null}
        end={quiet?.end ?? null}
      />
    </SettingsFrame>
  );
}
