// Settings > Alerts (UXN-304, M17 WP8, D-472): buy-price alerts, cleared-pick e-mails, intraday candidate
// e-mails, the daily cap (read-only), and quiet hours (held and sent as one digest; nothing here is P0).
// The values shown are the EFFECTIVE ones, the same rule the mailer applies, not the stored defaults.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadAlertSettings } from "@/lib/ui/loaders/pickAlerts";
import { QuietHoursForm } from "../QuietHoursForm";
import { SettingsForm } from "../SettingsForm";
import { Select, SettingsFrame } from "../SettingsNav";
import { setQuietHoursAction } from "../actions";
import { updateAlertSettingsAction } from "./actions";
import { ALERT_DELAY_HELP, ALERT_SETTING_WORDS } from "@/app/(app)/picks/text";

export const dynamic = "force-dynamic";

const ON_OFF: Array<[string, string]> = [
  ["on", "On"],
  ["off", "Off"],
];

export default async function AlertSettingsPage() {
  const user = await requireUser("own_preferences", "/settings/alerts");
  const s = await loadAlertSettings(await envFor(user));
  return (
    <SettingsFrame
      title="Alerts"
      intro="Pick alerts and their e-mails. Prices behind them are delayed; see the note below."
    >
      <SettingsForm action={updateAlertSettingsAction}>
        <Select
          name="pick_alerts"
          label={ALERT_SETTING_WORDS.pickAlerts}
          value={s.pickAlerts}
          options={ON_OFF}
          hint={
            s.alertsIsDefault
              ? "You have not chosen yet, so the standard setting for your role applies."
              : undefined
          }
        />
        <Select
          name="cleared_pick_emails"
          label={ALERT_SETTING_WORDS.cleared}
          value={s.clearedEmails}
          options={ON_OFF}
        />
        <Select
          name="intraday_candidate_emails"
          label={ALERT_SETTING_WORDS.candidates}
          value={s.candidateEmails}
          options={ON_OFF}
        />
        <p data-testid="daily-cap" className="m-0 text-sm">
          {ALERT_SETTING_WORDS.cap}:{" "}
          <strong>{s.dailyCap === null ? "not available" : s.dailyCap}</strong> (set by the Owner in
          Config; it cannot be changed here).
        </p>
      </SettingsForm>

      <section aria-labelledby="quiet-h" className="flex flex-col gap-2">
        <h2 id="quiet-h" className="m-0 text-base font-semibold">
          Quiet hours
        </h2>
        <p className="m-0 text-sm text-text-muted">{ALERT_SETTING_WORDS.quiet}</p>
        <QuietHoursForm action={setQuietHoursAction} start={s.quietStart} end={s.quietEnd} />
      </section>

      <p data-testid="delay-help" className="m-0 text-sm text-text-muted">
        {ALERT_DELAY_HELP}
      </p>
      <p className="m-0 text-sm">
        <Link href="/alerts" className="text-accent underline">
          See My alerts
        </Link>
      </p>
    </SettingsFrame>
  );
}
