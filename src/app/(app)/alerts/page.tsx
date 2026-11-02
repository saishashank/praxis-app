// My alerts (UXN-303, M17 WP8, D-473): the signed-in user's pick alerts for the last 30 sessions, by state,
// with the delivery status of each e-mail (sent, batched, held back). Actions: mute an armed alert, and turn
// alerts for all picks on or off. Masked users see letters, words and times, never a limit. Own rows only.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { loadMyAlerts } from "@/lib/ui/loaders/pickAlerts";
import { envFor } from "@/lib/ui/loaders/shell";
import { Money, Masked } from "@/components/ui/Values";
import { ALERT_DELAY_HELP, CLEAR_WORDS, MAIL_WORDS } from "../picks/text";
import { muteAlertAction, setAlertsForAllAction } from "./actions";
import { AllPicksToggle, MuteButton } from "./MuteButton";

export const dynamic = "force-dynamic";

const STATE_ORDER = ["armed", "hit", "cleared"] as const;
const STATE_TITLE = { armed: "Armed", hit: "Hit", cleared: "Cleared" } as const;

export default async function MyAlertsPage() {
  const user = await requireUser("own_preferences", "/alerts");
  const m = await loadMyAlerts(await envFor(user));
  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">My alerts</h1>
        <p className="m-0 text-sm text-text-muted">
          Buy-price alerts for the last 30 sessions. An alert tells you when a pick&apos;s delayed
          price reaches its buy limit. It never places an order.
        </p>
      </header>
      <AllPicksToggle action={setAlertsForAllAction} on={m.alertsOn} />
      {m.rows.length === 0 ? (
        <p data-testid="alerts-empty" className="m-0 rounded-md border border-border p-3 text-sm">
          No alerts yet.{" "}
          {m.alertsOn
            ? "They appear here once a pick is armed."
            : "Turn on alerts for all picks to start."}
        </p>
      ) : (
        STATE_ORDER.map((st) => {
          const rows = m.rows.filter((r) => r.state === st);
          if (rows.length === 0) return null;
          return (
            <section key={st} aria-labelledby={`alerts-${st}`} data-state={st}>
              <h2 id={`alerts-${st}`} className="m-0 mb-2 text-lg font-semibold">
                {STATE_TITLE[st]} ({rows.length})
              </h2>
              <ul className="m-0 list-none divide-y divide-border p-0">
                {rows.map((r) => (
                  <li
                    key={r.alertId}
                    data-testid="alert-row"
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="min-w-0 break-words">
                      <strong>{r.stock}</strong> · {r.profile} #{r.rank} · list of {r.pickDate} ·
                      limit {r.limit ? <Money micro={r.limit.micro} /> : <Masked />}
                      {r.hitTime ? ` · hit at ${r.hitTime} (delayed quote)` : ""}
                      {r.reason ? ` · ${CLEAR_WORDS[r.reason] ?? r.reason}` : ""}
                      <span className="text-text-muted"> · {MAIL_WORDS[r.mail]}</span>
                    </span>
                    {r.canMute ? (
                      <MuteButton action={muteAlertAction} alertId={r.alertId} stock={r.stock} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      <p className="m-0 text-xs text-text-muted">{ALERT_DELAY_HELP}</p>
      <p className="m-0 text-sm">
        <Link href="/settings/alerts" className="text-accent underline">
          Alert settings
        </Link>
        {" · "}
        <Link href="/picks" className="text-accent underline">
          Picks
        </Link>
      </p>
    </main>
  );
}
