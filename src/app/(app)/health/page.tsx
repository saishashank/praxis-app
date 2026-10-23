// System Health (PLT-061, PLT-017, UX-090/092/117). Every role may read status; secrets status,
// error details are Owner-only (ROL-102a) and never show values (SEC-101).
import type { ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne, type TimeFormat } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadControlRoom, type ControlRoomModel } from "@/lib/ui/loaders/controlRoom";
import { HealthNav, type HealthNavItem } from "./HealthNav";
import { Banner } from "@/components/ui/States";
import { ControlRoom, type SnoozeInfo } from "./ControlRoom";
import { CalendarConfirmForm } from "./CalendarConfirmForm";
import { DataControlForm } from "./DataControlForm";
import { EmailControlsSection } from "./EmailControlsSection";
import { WorkerSlotsSection } from "./WorkerSlotsSection";
import { loadSlotsView, type SlotsView } from "@/lib/golive/slots";
import { DayTimelineCheck } from "./DayTimelineCheck";
import { loadAttentionItems } from "@/lib/health/attention";
import {
  loadEmailControlsView,
  SOURCE_CONTROLS,
  type EmailControlsView,
} from "@/lib/data/controls";
import {
  confirmCalendarAction,
  resetAsxTripAction,
  setAsxEnabledAction,
  setDispatchEnabledAction,
  setMarketModeAction,
  setSourceAcceptedAction,
} from "./actions";
import {
  getHealthSummary,
  type HealthSummary,
  type JobState,
  type QuotaSummary,
  type WatchdogSummary,
} from "@/lib/health/summary";
import type { MeterLevel } from "@/lib/usage/meters";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<JobState, string> = {
  ok: "OK",
  stale: "STALE",
  failed: "FAILED",
  "no data": "NO DATA",
};

const QUOTA_LABEL: Record<MeterLevel, string> = {
  ok: "OK",
  notice: "NOTICE",
  alert: "ALERT",
  degrade: "DEGRADE",
  "no data": "NO DATA",
};

const WATCHDOG_LABEL: Record<WatchdogSummary["status"], string> = {
  ok: "OK",
  awaiting_first_approval: "Awaiting first approval",
  mismatch: "MISMATCH — S1 incident",
  unknown: "Unknown",
  "no data": "Not checked yet",
};

function quotaText(q: QuotaSummary | undefined): string {
  if (!q) return "Not available";
  const base = `Worst level: ${QUOTA_LABEL[q.level]}`;
  return q.meter !== undefined && q.ratio !== undefined
    ? `${base} (${q.meter}, ${(q.ratio * 100).toFixed(1)}%)`
    : base;
}

const SOURCE_STATUS_LABEL = {
  pending: "Not accepted yet",
  enabled: "Enabled",
  disabled: "Disabled",
  unknown: "Unknown",
} as const;

/** One setting: name and plain-words effect on the left, its control (or status) on the right. */
function ControlRow(props: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 sm:max-w-[60%]">
        <h3 className="m-0 text-sm font-semibold">{props.title}</h3>
        {props.detail ? <p className="m-0 mt-1 text-xs text-text-muted">{props.detail}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2 sm:items-end">{props.children}</div>
    </div>
  );
}

/** Read-only state for viewers and blocked switches: a pill with a dot and the word. */
function StatePill({ on, text }: { on: boolean; text?: string }) {
  return (
    <span
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${
        on ? "border-accent text-text" : "border-border text-text-muted"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${on ? "bg-accent" : "bg-text-muted"}`}
      />
      {text ?? (on ? "On" : "Off")}
    </span>
  );
}

const MODE_LABEL = { off: "Off", data_only: "Data only", full: "Full" } as const;

function DataControlsSection(props: {
  c: NonNullable<HealthSummary["controls"]>;
  incidents: HealthSummary["heartbeatIncidents"];
  owner: boolean;
  tf: TimeFormat;
}) {
  const { c, incidents, owner, tf } = props;
  const status = (source: string) => c.sources.find((x) => x.source === source)?.status;
  const asxReady = status("asx_announcements") === "enabled";
  const yahooReady = status("yahoo_eod") === "enabled";
  return (
    <section aria-labelledby="controls-h" className="flex flex-col gap-3">
      <h2 id="controls-h" className="text-xl font-semibold">
        Data controls
      </h2>
      {c.dataOnly && (
        <p role="status" className="m-0 text-sm text-text-muted">
          Production data-only mode (BLD-024): the nightly data pipeline runs; the Arena, emails and
          decision agents are off.
        </p>
      )}
      <div className="ui-card min-w-0 divide-y divide-border rounded-lg border border-border bg-surface">
        <ControlRow
          title="Nightly dispatch"
          detail="The Worker starts the nightly jobs (prices, books, signals, reviews)."
        >
          {!owner ? (
            <StatePill on={c.dispatchEnabled} />
          ) : c.dispatchEnabled ? (
            <DataControlForm
              action={setDispatchEnabledAction}
              fields={{ enabled: "0" }}
              label="Turn dispatch off"
              explain="The Worker stops starting the nightly jobs. Jobs already running finish."
              variant="switch"
              on
            />
          ) : !yahooReady || !c.calendarConfirmed ? (
            <>
              <StatePill on={false} />
              <span className="text-xs text-text-muted">
                {!yahooReady
                  ? "Accept the Yahoo source (O-26) first."
                  : "Confirm the AU trading calendar first."}
              </span>
            </>
          ) : (
            <DataControlForm
              action={setDispatchEnabledAction}
              fields={{ enabled: "1" }}
              label="Turn dispatch on"
              explain="The Worker starts the nightly jobs on production (Batch 1 reads Yahoo prices)."
              variant="switch"
            />
          )}
        </ControlRow>

        <ControlRow
          title="ASX contact"
          detail={`The Worker may contact asx.com.au for announcements and the company list.${
            c.asxTripped
              ? owner && c.asxTrippedReason
                ? ` Stopped by the safety trip: ${c.asxTrippedReason}.`
                : " Stopped by the safety trip."
              : ""
          }`}
        >
          {!owner ? (
            <StatePill on={c.asxEnabled} />
          ) : c.asxEnabled ? (
            <DataControlForm
              action={setAsxEnabledAction}
              fields={{ enabled: "0" }}
              label="Turn ASX contact off"
              explain="The Worker stops contacting asx.com.au at its next tick."
              variant="switch"
              on
            />
          ) : asxReady ? (
            <DataControlForm
              action={setAsxEnabledAction}
              fields={{ enabled: "1" }}
              label="Turn ASX contact on"
              explain="The Worker may contact asx.com.au (slowly, one request at a time) once ASX_LIVE and ASX_USER_AGENT are set in Cloudflare."
              variant="switch"
            />
          ) : (
            <>
              <StatePill on={false} />
              <span className="text-xs text-text-muted">Accept the ASX source (O-23) first.</span>
            </>
          )}
          {owner && c.asxTripped && (
            <DataControlForm
              action={resetAsxTripAction}
              fields={{}}
              label="Reset ASX trip"
              explain="This clears the safety trip so the Worker may contact ASX again once ASX contact is on. Only do this after you have checked why it tripped."
            />
          )}
        </ControlRow>

        {c.sources.map((x) => (
          <ControlRow
            key={x.source}
            title={`${x.label} (${x.ref})`}
            detail={`Data source. ${SOURCE_STATUS_LABEL[x.status]}.`}
          >
            {!owner ? (
              <StatePill on={x.status === "enabled"} text={SOURCE_STATUS_LABEL[x.status]} />
            ) : x.status === "enabled" ? (
              <DataControlForm
                action={setSourceAcceptedAction}
                fields={{ source: x.source, accept: "0" }}
                label={`Disable ${x.label}`}
                explain={`Disabling ${x.label} stops contact with it.${
                  x.source === "asx_announcements" ? " ASX contact is also switched off." : ""
                } You can accept the risk again later.`}
                variant="switch"
                on
              />
            ) : (
              <DataControlForm
                action={setSourceAcceptedAction}
                fields={{ source: x.source, accept: "1" }}
                label={`Accept risk (${x.ref})`}
                explain={SOURCE_CONTROLS[x.source].riskText}
                checkbox={`I accept this risk (${x.ref}).`}
                confirmLabel="Accept risk"
                variant="switch"
              />
            )}
          </ControlRow>
        ))}

        {c.markets.map((m) => (
          <ControlRow
            key={m.market}
            title={`${m.market} market mode`}
            detail={`Off: nothing runs. Data only: prices and announcements, no trading. Full: paper trading, emails and agents.${
              owner && !m.inSync ? " Out of sync with the saved setting." : ""
            }`}
          >
            <div
              role="group"
              aria-label={`${m.market} market mode`}
              className="flex flex-wrap items-start gap-1 rounded-lg border border-border p-1"
            >
              {(["off", "data_only", "full"] as const).map((mode) =>
                mode === m.mode ? (
                  <span
                    key={mode}
                    aria-current="true"
                    className="inline-flex min-h-10 items-center gap-1 rounded-md bg-accent px-3 text-sm font-semibold text-accent-contrast"
                  >
                    ✓ {MODE_LABEL[mode]} <span className="sr-only">(current)</span>
                  </span>
                ) : owner ? (
                  <DataControlForm
                    key={mode}
                    action={setMarketModeAction}
                    fields={{ market: m.market, mode }}
                    label={MODE_LABEL[mode]}
                    variant="segment"
                    confirmLabel={mode === "full" ? "Switch to full" : "Confirm"}
                    explain={
                      mode === "full"
                        ? "Starts real paper trading: the Arena, emails and decision agents run. In production this is refused until the go-live sign-off is recorded and the email mode is not off."
                        : mode === "off"
                          ? "The pipeline and the Worker skip this market until you set it back to data-only."
                          : m.mode === "full"
                            ? "Trading stops: the Arena, emails and decision agents switch off. The nightly data pipeline keeps running."
                            : "The nightly data pipeline and the Worker work for this market again. Nothing else runs."
                    }
                  />
                ) : (
                  <span
                    key={mode}
                    className="inline-flex min-h-10 items-center px-3 text-sm text-text-muted"
                  >
                    {MODE_LABEL[mode]}
                  </span>
                ),
              )}
            </div>
          </ControlRow>
        ))}
      </div>
      {owner && (
        <>
          <p className="m-0 text-xs text-text-muted">
            The Worker also needs ASX_LIVE=1 and ASX_USER_AGENT in Cloudflare. Last Worker report:
            ASX_LIVE {c.workerVars.asxLive}, ASX_USER_AGENT {c.workerVars.asxUserAgent}.
          </p>
          <div className="text-sm">
            <h3 className="font-medium">Open S2 incidents</h3>
            {incidents === null || incidents === undefined ? (
              <p className="text-text-muted">Incident list unavailable.</p>
            ) : incidents.length === 0 ? (
              <p className="text-text-muted">None</p>
            ) : (
              <ul className="list-disc pl-5">
                {incidents.map((i) => (
                  <li key={i.id}>
                    {i.kind.replace(/_/g, " ")} — opened {formatMelbourne(i.at, tf)}
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

function SecretsSection(props: {
  id: string;
  title: string;
  empty: string;
  data: NonNullable<HealthSummary["secrets"]>;
  tf: TimeFormat;
}) {
  const { id, title, empty, data, tf } = props;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <p className="text-sm text-text-muted">
        Last verified: {formatMelbourne(data.lastVerifiedAt, tf)}. Values are never shown.
      </p>
      {data.results.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col" className="py-2 pr-4">
                Secret check
              </th>
              <th scope="col" className="py-2 pr-4">
                Result
              </th>
              <th scope="col" className="py-2">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((r) => (
              <tr key={r.name} className="border-t border-border">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {r.name}
                </th>
                <td className="py-2 pr-4 font-mono text-xs">
                  {r.pending ? "PENDING" : r.ok ? "PASS" : "FAIL"}
                </td>
                <td className="py-2">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function QualitySection(props: { q: NonNullable<HealthSummary["quality"]>; owner: boolean }) {
  const { q, owner } = props;
  const u1 = q.tiers.find((t) => t.tier === "U1");
  return (
    <>
      <p role="status" className="text-sm">
        <span className="rounded border px-2 py-0.5 font-mono text-xs">
          {u1 === undefined ? "NO DATA" : u1.gatePass ? "PASS" : "FAIL — no new entries"}
        </span>
        <span className="ml-2 text-text-muted">
          Latest date: {q.date}. Exits are never blocked.
        </span>
      </p>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Quality score per tier</caption>
        <thead>
          <tr>
            <th scope="col" className="py-2 pr-4">
              Tier
            </th>
            <th scope="col" className="py-2 pr-4">
              Valid bars
            </th>
            <th scope="col" className="py-2">
              Score
            </th>
          </tr>
        </thead>
        <tbody>
          {q.tiers.map((t) => (
            <tr key={t.tier} className="border-t border-border">
              <th scope="row" className="py-2 pr-4 font-medium">
                {t.tier}
              </th>
              <td className="py-2 pr-4">
                {t.valid} of {t.expected}
              </td>
              <td className="py-2">{(t.score * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.rules.length === 0 ? (
        <p className="text-sm text-text-muted">No open flags for this date.</p>
      ) : (
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Open flags by rule</caption>
          <thead>
            <tr>
              <th scope="col" className="py-2 pr-4">
                Rule
              </th>
              <th scope="col" className="py-2 pr-4">
                Severity
              </th>
              <th scope="col" className="py-2 pr-4">
                Open flags
              </th>
              <th scope="col" className="py-2 pr-4">
                Blocks entries
              </th>
              {owner && (
                <th scope="col" className="py-2">
                  Codes
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {q.rules.map((r) => (
              <tr key={`${r.checkId}-${r.severity}`} className="border-t border-border">
                <th scope="row" className="py-2 pr-4 font-mono text-xs font-medium">
                  {r.checkId}
                </th>
                <td className="py-2 pr-4">{r.severity}</td>
                <td className="py-2 pr-4">{r.count}</td>
                <td className="py-2 pr-4">{r.blocksEntries ? "Yes" : "No"}</td>
                {owner && (
                  <td className="py-2 font-mono text-xs">{(r.topCodes ?? []).join(", ")}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default async function HealthPage() {
  const user = await requireUser("read", "/health");
  const tf = (await userPreferences(user.id)).time_format;
  let summary: HealthSummary | null = null;
  try {
    summary = await getHealthSummary(mainDb(), new Date(), user.role);
  } catch {
    summary = null; // neutral message below; no error details
  }
  // M5 email and alert controls: Owner only; unreadable data shows "unavailable", never details.
  let emailControls: EmailControlsView | null = null;
  if (user.role === "owner") {
    try {
      const db = mainDb();
      emailControls = await loadEmailControlsView(db, await loadAttentionItems(db));
    } catch {
      emailControls = null;
    }
  }
  // Worker slots (M8 T11): Owner only; unreadable data shows "unavailable".
  let slotsView: SlotsView | null = null;
  if (user.role === "owner") {
    try {
      slotsView = await loadSlotsView(mainDb());
    } catch {
      slotsView = null;
    }
  }
  const owner = user.role === "owner";
  // The Control Room: ring, readouts, briefing, gauges, strip, ticker (UXN-283/285). A failed read
  // shows a neutral line, never details; the older sections below keep working on their own.
  let model: ControlRoomModel | null = null;
  try {
    model = await loadControlRoom(await envFor({ id: user.id, role: user.role }));
  } catch {
    model = null;
  }
  const snooze: SnoozeInfo | null = emailControls
    ? { items: emailControls.attention, maxDays: emailControls.attentionSnoozeMaxDays }
    : null;

  // The section menu lists exactly the sections rendered below (same conditions).
  const nav: HealthNavItem[] = [{ id: "overview", label: "Overview" }];
  if (summary !== null) {
    if (summary.watchdog) nav.push({ id: "approval-h", label: "Code approval" });
    nav.push({ id: "jobs-h", label: "Jobs" });
    if (summary.calendar && summary.calendar.length > 0) {
      nav.push({ id: "calendar-h", label: "Trading calendar" });
    }
    if (summary.controls) nav.push({ id: "controls-h", label: "Data controls" });
    if (owner) nav.push({ id: "email-controls-h", label: "Email and alerts" });
    nav.push({ id: "day-timeline-h", label: "Day timeline" });
    if (owner) nav.push({ id: "worker-slots-h", label: "Worker slots" });
    if (summary.quality) nav.push({ id: "quality-h", label: "Data quality" });
    if (owner && summary.secrets) nav.push({ id: "secrets-h", label: "Secrets" });
    if (owner && summary.workerSecrets) {
      nav.push({ id: "worker-secrets-h", label: "Worker secrets" });
    }
  }
  nav.push({ id: "more-h", label: "Other status" });

  return (
    <main className="mx-auto grid min-w-0 grid-cols-1 gap-6 py-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <HealthNav items={nav} />
      <div className="flex min-w-0 flex-col gap-8">
        <header id="overview" className="flex scroll-mt-20 flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">System Health</h1>
          <p className="m-0 text-sm text-text-muted">
            The Control Room. Times are shown in Australia/Melbourne.
          </p>
        </header>

        {model === null ? (
          <Banner tone="warning" title="Control Room unavailable">
            The health facts could not be read just now. The sections below may still be current.
          </Banner>
        ) : (
          <ControlRoom model={model} owner={owner} tf={tf} snooze={snooze} />
        )}

        {summary === null ? (
          <p role="status">Health data unavailable</p>
        ) : (
          <>
            {summary.watchdog && (
              <section aria-labelledby="approval-h" className="flex flex-col gap-3">
                <h2 id="approval-h" className="text-xl font-semibold">
                  Production code approval
                </h2>
                <p role="status" className="text-sm">
                  <span className="rounded border px-2 py-0.5 font-mono text-xs">
                    {WATCHDOG_LABEL[summary.watchdog.status]}
                  </span>
                  <span className="ml-2 text-text-muted">
                    Last checked: {formatMelbourne(summary.watchdog.checkedAt, tf)}
                  </span>
                </p>
                {owner && summary.watchdog.status !== "no data" && (
                  <p className="text-sm text-text-muted">
                    Approved commit: {summary.watchdog.approvedShort ?? "none"}. Deployed commit:{" "}
                    {summary.watchdog.deployedShort ?? "unknown"}.
                  </p>
                )}
                {owner && summary.openIncidents !== undefined && (
                  <div className="text-sm">
                    <h3 className="font-medium">Open S1 incidents</h3>
                    {summary.openIncidents === null ? (
                      <p className="text-text-muted">Incident list unavailable.</p>
                    ) : summary.openIncidents.length === 0 ? (
                      <p className="text-text-muted">None</p>
                    ) : (
                      <ul className="list-disc pl-5">
                        {summary.openIncidents.map((i) => (
                          <li key={i.id}>
                            {i.kind.replace(/_/g, " ")} — opened {formatMelbourne(i.at, tf)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            )}

            <section aria-labelledby="jobs-h" className="flex flex-col gap-3">
              <h2 id="jobs-h" className="text-xl font-semibold">
                Jobs
              </h2>
              <p className="text-sm text-text-muted">
                A job is flagged stale when its last success is older than twice its expected
                interval.
              </p>
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Job freshness</caption>
                <thead>
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Job
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      State
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Last success
                    </th>
                    {owner && (
                      <th scope="col" className="py-2">
                        Error details
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {summary.jobs.map((j) => (
                    <tr key={j.job} className="border-t border-border">
                      <th scope="row" className="py-2 pr-4 font-medium">
                        {j.label}
                      </th>
                      <td className="py-2 pr-4">
                        <span className="rounded border px-2 py-0.5 font-mono text-xs">
                          {STATE_LABEL[j.state]}
                        </span>
                        {j.note && <span className="ml-2 text-text-muted">{j.note}</span>}
                        {j.stale && j.state !== "stale" && (
                          <span className="ml-2 font-medium">Also stale</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{formatMelbourne(j.lastSuccessAt, tf)}</td>
                      {owner && <td className="py-2">{j.errorSummary ?? "None"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {summary.calendar && summary.calendar.length > 0 && (
              <section aria-labelledby="calendar-h" className="flex flex-col gap-3">
                <h2 id="calendar-h" className="text-xl font-semibold">
                  Trading calendar
                </h2>
                <ul className="flex flex-col gap-2 text-sm">
                  {summary.calendar.map((c) => (
                    <li key={`${c.market}-${c.year}`} className="flex flex-wrap items-center gap-2">
                      <span>
                        {c.market} trading calendar {c.year}: {c.tradingDays} days,{" "}
                        <span className="rounded border px-2 py-0.5 font-mono text-xs">
                          {c.unconfirmed === 0 ? "CONFIRMED" : "NOT CONFIRMED"}
                        </span>
                      </span>
                      {owner && c.unconfirmed > 0 && (
                        <CalendarConfirmForm
                          action={confirmCalendarAction}
                          market={c.market}
                          year={c.year}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {summary.controls && (
              <DataControlsSection
                c={summary.controls}
                incidents={summary.heartbeatIncidents}
                owner={owner}
                tf={tf}
              />
            )}

            {owner && <EmailControlsSection v={emailControls} />}
            <DayTimelineCheck owner={owner} />

            {owner && <WorkerSlotsSection view={slotsView} />}

            {summary.quality && (
              <section aria-labelledby="quality-h" className="flex flex-col gap-3">
                <h2 id="quality-h" className="text-xl font-semibold">
                  Data quality
                </h2>
                {summary.quality.date === null ? (
                  <p className="text-sm text-text-muted">No quality checks have run yet.</p>
                ) : (
                  <QualitySection q={summary.quality} owner={owner} />
                )}
              </section>
            )}

            {owner && summary.secrets && (
              <SecretsSection
                id="secrets-h"
                title="Secrets status"
                empty="No self-check has been recorded yet."
                data={summary.secrets}
                tf={tf}
              />
            )}

            {owner && summary.workerSecrets && (
              <SecretsSection
                id="worker-secrets-h"
                title="Worker secrets status"
                empty="No Worker self-check has been recorded yet."
                data={summary.workerSecrets}
                tf={tf}
              />
            )}
          </>
        )}

        <section aria-labelledby="more-h" className="flex flex-col gap-3">
          <h2 id="more-h" className="text-xl font-semibold">
            Other status
          </h2>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div className="flex flex-col">
              <dt className="font-medium">Quota usage</dt>
              <dd className="text-text-muted">{quotaText(summary?.quota)}</dd>
            </div>
            {owner && (
              <div className="flex flex-col">
                <dt className="font-medium">Go-live</dt>
                <dd className="text-text-muted">
                  <Link href="/ops/go-live" className="text-accent underline">
                    Go-live record
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </main>
  );
}
