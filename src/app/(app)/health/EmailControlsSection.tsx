// System Health "Email and alerts" controls (M5 T2, Owner only). A plain server component: the page
// loads the view (src/lib/data/controls.ts loadEmailControlsView) and passes it in. Every change goes
// through DataControlForm's confirmation step and a server action that re-checks the Owner and writes
// the audit event first (docs/M5_design.md 4.12, 4.7, 3).
import type { EmailControlsView } from "@/lib/data/controls";
import { DataControlForm } from "./DataControlForm";
import {
  addWatchListCodeAction,
  removeWatchListCodeAction,
  setCredentialExpiryAction,
  setEmailModeAction,
  setEmailReviewTestDateAction,
  snoozeAttentionAction,
} from "./emailActions";

const MODE_LABEL = {
  off: "Off (nothing is emailed)",
  incidents: "Incidents only",
  full: "Full",
} as const;

const MODE_EXPLAIN = {
  off: "No email of any kind is sent. Nothing is lost: every review and alert stays readable in the app.",
  incidents:
    "Only incident emails are sent (a problem opens or gets worse, tokens due, an unread review after 7 days, the database unreachable, and the watchdog's minimal review if the app is down). No daily review, no alert emails.",
  full: "Every email is sent: the Evening Review, P0 alert emails, incidents, the attention reminder and the Morning Brief if you turned it on.",
} as const;

export function EmailControlsSection({ v }: { v: EmailControlsView | null }) {
  return (
    <section aria-labelledby="email-controls-h" className="flex flex-col gap-3">
      <h2 id="email-controls-h" className="text-xl font-semibold">
        Email and alert controls
      </h2>
      {v === null ? (
        <p className="text-sm text-text-muted">Email controls are unavailable.</p>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Only you can change these. Each change asks you to confirm and is written to the audit
            log first.
          </p>

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-medium">Email mode</h3>
            <p>
              Now: <strong>{MODE_LABEL[v.mode]}</strong>
            </p>
            {(["off", "incidents", "full"] as const)
              .filter((m) => m !== v.mode)
              .map((m) =>
                m === "full" && v.dataOnly ? (
                  <p key={m} className="text-text-muted">
                    Full email stays unavailable while a market is in data-only mode (until
                    go-live).
                  </p>
                ) : (
                  <DataControlForm
                    key={m}
                    action={setEmailModeAction}
                    fields={{ mode: m }}
                    label={`Set email to: ${MODE_LABEL[m]}`}
                    explain={MODE_EXPLAIN[m]}
                  />
                ),
              )}
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-medium">One-off review test date</h3>
            <p>
              Now: <strong>{v.reviewTestDate ?? "none"}</strong>
            </p>
            {v.mode === "incidents" ? (
              <DataControlForm
                action={setEmailReviewTestDateAction}
                fields={{}}
                label={v.reviewTestDate ? "Change the test date" : "Set a test date"}
                explain="On this one Melbourne date (today up to 31 days ahead) the Evening Review is checked and emailed even though the mode is incidents only. It switches itself off after that date. Leave the date empty to clear it."
                inputs={[{ name: "date", label: "Date", type: "date" }]}
              />
            ) : (
              <p className="text-text-muted">
                Set the email mode to incidents only first; a test date needs it.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-medium">Watch-list (codes you added)</h3>
            {v.watchList.length === 0 ? (
              <p className="text-text-muted">None</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {v.watchList.map((w) => (
                  <li key={`${w.market}-${w.code}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">
                      {w.market}:{w.code}
                    </span>
                    <span className="text-text-muted">until {w.expiresD}</span>
                    <DataControlForm
                      action={removeWatchListCodeAction}
                      fields={{ market: w.market, code: w.code }}
                      label={`Remove ${w.code}`}
                      explain={`${w.code} stops counting as a watch-list code for alerts.`}
                    />
                  </li>
                ))}
              </ul>
            )}
            <DataControlForm
              action={addWatchListCodeAction}
              fields={{ market: "AU" }}
              label="Add a code"
              explain={`The code joins the watch-list, so announcements about it can raise alerts. It must be a listed AU share. It stays for at most ${v.watchListMaxDays} days.`}
              inputs={[
                { name: "code", label: "Code (for example BHP)", type: "text", required: true },
                {
                  name: "days",
                  label: "Days on the list",
                  type: "number",
                  defaultValue: String(v.watchListMaxDays),
                  min: 1,
                  max: v.watchListMaxDays,
                  required: true,
                },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-medium">Credential expiry dates</h3>
            <p className="text-text-muted">
              Enter the date each token expires. You get one combined email 14, 7 and 2 days before
              the earliest one. Only the name and the date are stored, never the secret.
            </p>
            <ul className="flex flex-col gap-1">
              {v.credentials.map((c) => (
                <li key={c.name} className="flex flex-wrap items-center gap-2">
                  <span>{c.label}</span>
                  <span className="text-text-muted">{c.expiresOn ?? "no date set"}</span>
                </li>
              ))}
            </ul>
            <DataControlForm
              action={setCredentialExpiryAction}
              fields={{}}
              label="Set an expiry date"
              explain="Records the expiry date for one secret. Today up to about five years ahead."
              inputs={[
                {
                  name: "name",
                  label: "Secret",
                  type: "select",
                  options: v.credentials.map((c) => ({ value: c.name, label: c.label })),
                  required: true,
                },
                { name: "expires_on", label: "Expires on", type: "date", required: true },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-medium">Attention items</h3>
            {v.attention.length === 0 ? (
              <p className="text-text-muted">Nothing needs attention.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {v.attention.map(({ item, snoozedUntil }) => (
                  <li
                    key={`${item.component}-${item.key}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span>{item.label}</span>
                    <span className="rounded border px-2 py-0.5 font-mono text-xs">
                      {item.state === "down" ? "RED" : "ATTENTION"}
                    </span>
                    {item.deadlineD && (
                      <span className="text-text-muted">deadline {item.deadlineD}</span>
                    )}
                    {snoozedUntil ? (
                      <span className="text-text-muted">snoozed until {snoozedUntil}</span>
                    ) : item.state === "down" ? (
                      <span className="text-text-muted">cannot be snoozed</span>
                    ) : (
                      <DataControlForm
                        action={snoozeAttentionAction}
                        fields={{ component: item.component, item_key: item.key }}
                        label="Snooze"
                        explain="The daily attention reminder leaves this item out for the days you choose. Red items and items within 2 days of a deadline are never left out."
                        inputs={[
                          {
                            name: "days",
                            label: "Days",
                            type: "number",
                            defaultValue: "1",
                            min: 1,
                            max: v.attentionSnoozeMaxDays,
                            required: true,
                          },
                        ]}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
