// The Control Room (UXN-283, UXN-285; docs/M7_design.md 3 row 26): status ring, numbered readouts,
// status briefing, free-tier gauges, 30-day strip, event ticker and the A1-A8 panel under "Show
// details". A server component over the view model of `loadControlRoom`; the one client island is
// ControlRoomClient (boot, refresh, focus mode). Role split (decision 23): everyone sees the ring, the
// states, "n / 9 healthy", the briefing and the ticker; fix actions, snooze, deadlines and usage
// numbers are Owner-only; Editors and Viewers get one plain line per part.
import { clamp, n } from "@/components/charts/format";
import { ChartTable } from "@/components/charts";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { StatusStrip as StatusBar } from "@/components/ui/StatusStrip";
import { EmptyState, ShowDetails } from "@/components/ui/States";
import { formatMelbourne, type TimeFormat } from "@/lib/health/format";
import type { AttentionItem } from "@/lib/health/attention";
import type { ControlRoomModel, GaugeView } from "@/lib/ui/loaders/controlRoom";
import { GAUGE_MARKS } from "@/lib/ui/loaders/controlRoom";
import type { HealthComponentView } from "@/lib/ui/loaders/health";
import { DataControlForm } from "./DataControlForm";
import { ControlRoomClient } from "./ControlRoomClient";
import { ControlRoomRing } from "./ControlRoomRing";
import styles from "./ControlRoom.module.css";
import {
  anchorOf,
  briefingLines,
  COMPONENT_SPEC,
  nameOf,
  plainReason,
  STATE_MARK,
  STATE_WORD,
} from "./ControlRoomText";
import { snoozeAttentionAction } from "./emailActions";

export type SnoozeInfo = {
  /** Open attention items with their snooze state, from the Owner's email controls view. */
  items: ReadonlyArray<{ item: AttentionItem; snoozedUntil: string | null }>;
  maxDays: number;
};

// UXR-045: a status pill that always carries the word (never colour alone) plus the state mark.
const PILL_VALUE: Record<string, string> = { healthy: "ok", attention: "warn", down: "bad" };

function StateBadge({ state }: { state: string }) {
  return (
    <span data-state={state} className="inline-flex shrink-0">
      <Pill kind="status" value={PILL_VALUE[state] ?? "neutral"}>
        <span aria-hidden="true">{STATE_MARK[state]}</span> {STATE_WORD[state] ?? state}
      </Pill>
    </span>
  );
}

function Readout({
  index,
  c,
  owner,
  checked,
  snooze,
}: {
  index: number;
  c: HealthComponentView;
  owner: boolean;
  checked: string;
  snooze: SnoozeInfo | null;
}) {
  const reason = plainReason(c, owner);
  return (
    <li className="list-none">
      <details
        id={anchorOf(c.id)}
        className={`${styles.readout} ${styles.checkin} ${styles.tick} p-3`}
        style={{ ["--i" as string]: index }}
        data-component={c.id}
        data-state={c.state}
      >
        <summary className="flex min-h-6 cursor-pointer flex-wrap items-center gap-2">
          <span className={`${styles.num} text-sm text-text-muted`}>{index + 1}</span>
          <span className="font-semibold">{nameOf(c.id)}</span>
          <StateBadge state={c.state} />
          <span className="min-w-0 basis-full text-sm break-words text-text-muted sm:basis-auto">
            {reason}
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p className="m-0">{reason}</p>
          <p className="m-0 text-text-muted">
            Last check: {checked}. Reference: {COMPONENT_SPEC[c.id] ?? "PLT-061"}.
          </p>
          {owner && c.items.length > 0 && (
            <ul className="m-0 flex flex-col gap-2 p-0">
              {c.items.map((it) => {
                const sn = snooze?.items.find(
                  (x) => x.item.component === c.id && x.item.key === it.key,
                );
                return (
                  <li key={it.key} className="list-none rounded-md bg-surface-2 p-2">
                    <p className="m-0 font-medium">{it.label}</p>
                    <p className="m-0 text-text-muted">
                      {it.state === "down" ? "Down" : "Needs attention"}
                      {it.deadlineD ? `, deadline ${it.deadlineD}` : ""}
                    </p>
                    <p className="m-0">Fix: {it.fix}</p>
                    {it.state === "down" ? (
                      <p className="m-0 text-text-muted">Red items cannot be snoozed.</p>
                    ) : (
                      <>
                        <p className="m-0 text-text-muted">
                          Reminder emailed daily at 08:00 until fixed.
                          {sn?.snoozedUntil ? ` Snoozed until ${sn.snoozedUntil}.` : ""}
                        </p>
                        {snooze && !sn?.snoozedUntil && (
                          <DataControlForm
                            action={snoozeAttentionAction}
                            fields={{ component: c.id, item_key: it.key }}
                            label="Snooze reminder"
                            explain="The daily attention reminder leaves this item out for the days you choose (1, 3 or 7). Red items and items within 2 days of a deadline are never left out."
                            inputs={[
                              {
                                name: "days",
                                label: "Days (1, 3 or 7)",
                                type: "select",
                                options: [1, 3, 7]
                                  .filter((d) => d <= snooze.maxDays)
                                  .map((d) => ({
                                    value: String(d),
                                    label: `${d} day${d > 1 ? "s" : ""}`,
                                  })),
                                defaultValue: "1",
                                required: true,
                              },
                            ]}
                          />
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

// --- Gauges (UXN-285 d): radial arc with the 70 / 90 / 95 marks (PLT-051) ---
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(r: number, from: number, to: number): string {
  const [x1, y1] = polar(60, 60, r, from);
  const [x2, y2] = polar(60, 60, r, to);
  return `M${n(x1)} ${n(y1)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${n(x2)} ${n(y2)}`;
}

export function UsageGauge({ g }: { g: GaugeView }) {
  const v = g.percent === null ? null : clamp(g.percent, 0, 100);
  const at = (p: number): number => -135 + (p / 100) * 270;
  const fill =
    v !== null && v >= 90
      ? "var(--color-breaker-red)"
      : v !== null && v >= 70
        ? "var(--color-breaker-amber)"
        : "var(--color-breaker-green)";
  const crossed = (m: number): boolean => v !== null && v >= m;
  const summary =
    v === null
      ? `${g.label}: no data yet`
      : `${g.label}: ${n(v)}% of the free limit used. ${GAUGE_MARKS.filter(crossed).length ? `Past the ${GAUGE_MARKS.filter(crossed).join(", ")}% mark.` : "Below the 70% mark."}`;
  return (
    <figure className="m-0 min-w-0 text-center" data-gauge={g.id}>
      <svg
        role="img"
        aria-label={summary}
        viewBox="0 0 120 110"
        className="mx-auto w-full max-w-[160px]"
      >
        <path d={arc(44, -135, 135)} fill="none" stroke="var(--color-grid)" strokeWidth={8} />
        {v !== null && v > 0 && (
          <path d={arc(44, -135, at(v))} fill="none" stroke={fill} strokeWidth={8} />
        )}
        {GAUGE_MARKS.map((m) => {
          const [x1, y1] = polar(60, 60, 37, at(m));
          const [x2, y2] = polar(60, 60, 52, at(m));
          return (
            <line
              key={m}
              data-mark={m}
              data-crossed={crossed(m) ? "true" : "false"}
              x1={n(x1)}
              y1={n(y1)}
              x2={n(x2)}
              y2={n(y2)}
              stroke={crossed(m) ? "var(--color-breaker-amber)" : "var(--color-text)"}
              strokeWidth={crossed(m) ? 3 : 2}
            />
          );
        })}
        <text
          x={60}
          y={64}
          fontSize={19}
          textAnchor="middle"
          fill="var(--color-text)"
          fontFamily="var(--font-mono)"
        >
          {v === null ? "–" : `${n(v)}%`}
        </text>
      </svg>
      <figcaption className="mt-1 text-sm">
        <span className="font-medium">{g.label}</span>
        <span className="block text-xs text-text-muted">
          {v === null
            ? "No data yet"
            : crossed(70)
              ? `Past the ${[...GAUGE_MARKS].reverse().find(crossed)}% mark`
              : "Under the 70% mark"}
        </span>
      </figcaption>
      <ChartTable
        caption={g.label}
        headers={["Measure", "Value"]}
        rows={[
          ["Used", v === null ? "no data" : `${n(v)}%`],
          ...GAUGE_MARKS.map((m) => [`${m}% mark`, crossed(m) ? "reached" : "not reached"]),
        ]}
      />
    </figure>
  );
}

// --- 30-day strip (UXN-283, decision 60): one bar per stored day ---
export function StatusStrip({ strip }: { strip: ControlRoomModel["health"]["strip"] }) {
  if (strip.length === 0) {
    return (
      <p className="m-0 text-sm text-text-muted">
        No daily health records yet. One is stored each night.
      </p>
    );
  }
  const W = 10; // threshold-ok: svg bar pitch
  const allOk = strip.filter((s) => s.healthy === s.total).length;
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={`Last ${strip.length} days: ${allOk} with every part healthy, ${strip.length - allOk} with something to look at`}
        viewBox={`0 0 ${strip.length * W} 34`}
        className="h-10 w-full max-w-md"
        preserveAspectRatio="none"
      >
        {strip.map((s, i) => {
          const frac = s.total === 0 ? 0 : s.healthy / s.total;
          const ok = s.total > 0 && s.healthy === s.total;
          return (
            <g key={s.d}>
              <rect x={i * W} y={0} width={W - 2} height={30} fill="var(--color-surface-2)" />
              <rect
                x={i * W}
                y={30 - 30 * frac}
                width={W - 2}
                height={30 * frac}
                fill={ok ? "var(--color-breaker-green)" : "var(--color-breaker-amber)"}
              />
              {!ok && (
                <rect x={i * W} y={31} width={W - 2} height={3} fill="var(--color-breaker-amber)" />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-text-muted">
        {strip.length} days recorded, {allOk} fully healthy. Marked bars had something to look at.
      </figcaption>
      <ChartTable
        caption="Healthy parts per day"
        headers={["Day", "Healthy parts"]}
        rows={strip.map((s) => [s.d, `${s.healthy} of ${s.total}`])}
      />
    </figure>
  );
}

function Timeline({ events }: { events: ControlRoomModel["timeline"] }) {
  if (events.length === 0) {
    return <p className="m-0 text-sm text-text-muted">No changes recorded in the last 30 days.</p>;
  }
  return (
    <ol className="m-0 flex flex-col gap-1 p-0 text-sm">
      {events.map((e, i) => (
        <li key={`${e.d}-${e.component}-${i}`} className="list-none">
          <span className={`${styles.num} text-text-muted`}>{e.d}</span> {nameOf(e.component)}:{" "}
          {STATE_WORD[e.from] ?? e.from} to {STATE_WORD[e.to] ?? e.to}
        </li>
      ))}
    </ol>
  );
}

function AgentPanel({ agents, tf }: { agents: ControlRoomModel["agents"]; tf: TimeFormat }) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <caption className="sr-only">The eight agents and their last run</caption>
      <thead>
        <tr>
          <th scope="col" className="py-2 pr-3">
            Agent
          </th>
          <th scope="col" className="py-2 pr-3">
            Runs
          </th>
          <th scope="col" className="py-2 pr-3">
            Last run
          </th>
          <th scope="col" className="py-2 pr-3">
            Outputs
          </th>
          <th scope="col" className="py-2">
            Status
          </th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.id} className="border-t border-border">
            <th scope="row" className="py-2 pr-3 font-medium">
              {a.name} ({a.id})
            </th>
            <td className="py-2 pr-3 text-text-muted">{a.when}</td>
            <td className="py-2 pr-3">{a.lastAt ? formatMelbourne(a.lastAt, tf) : "Never"}</td>
            <td className="py-2 pr-3">{a.outputs === null ? "Not measured" : a.outputs}</td>
            <td className="py-2">
              {a.status === "ok"
                ? "OK"
                : a.status === "not tracked"
                  ? "Not tracked on its own"
                  : a.status}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ControlRoom({
  model,
  owner,
  tf,
  snooze,
}: {
  model: ControlRoomModel;
  owner: boolean;
  tf: TimeFormat;
  snooze: SnoozeInfo | null;
}) {
  const h = model.health;
  const checked = formatMelbourne(model.checkedAt, tf);
  const lines = briefingLines(h.healthy, h.total, h.components, owner);
  return (
    <ControlRoomClient briefing={lines.join(" ")}>
      {h.state === "stale" && (
        <p className="m-0 rounded-lg border border-border bg-surface p-3 text-sm" data-stale="">
          <strong>Some health facts could not be read.</strong> The database did not answer just
          now, so the parts shown may be out of date. Last check: {checked}.
        </p>
      )}
      <Card title="Status briefing" data-briefing="">
        <ul className="m-0 flex flex-col gap-1 p-0 text-sm">
          {lines.map((l) => (
            <li key={l} className="list-none">
              {l}
            </li>
          ))}
        </ul>
        <p className="mt-2 mb-0 text-xs text-text-muted">
          Written from the stored health facts by a fixed template, not by an AI model.
        </p>
      </Card>

      <StatusBar
        label="Health overview"
        items={[
          {
            label: "Status ring",
            value: (
              <ControlRoomRing components={h.components} healthy={h.healthy} total={h.total} />
            ),
          },
          { label: "Healthy", value: `${h.healthy} of ${h.total}` },
          {
            label: "Needs attention",
            value: String(h.components.filter((c) => c.state === "attention").length),
          },
          { label: "Down", value: String(h.components.filter((c) => c.state === "down").length) },
          { label: "Last check", value: checked },
        ]}
      />
      <ol aria-label="Numbered readouts" className="m-0 flex min-w-0 flex-col gap-2 p-0">
        {h.components.map((c, i) => (
          <Readout key={c.id} index={i} c={c} owner={owner} checked={checked} snooze={snooze} />
        ))}
      </ol>

      <p className="m-0 text-sm text-text-muted" data-testid="steelman-health">
        {h.steelman.text}
      </p>

      <Card title="Free-tier limits">
        {model.gauges === null ? (
          <p className="m-0 text-sm text-text-muted">
            {h.components.find((c) => c.id === "free_tier_limits")?.state === "healthy"
              ? "All free-tier limits are within bounds. The numbers are shown to the Owner."
              : "A free-tier limit needs the Owner. The numbers are shown to the Owner."}
          </p>
        ) : model.gauges.length === 0 ? (
          <EmptyState motif="check" hue="home" title="No usage numbers yet">
            The meters fill in as the system runs.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {model.gauges.map((g) => (
              <UsageGauge key={g.id} g={g} />
            ))}
          </div>
        )}
      </Card>

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <Card title="Last 30 days">
          <StatusStrip strip={h.strip} />
        </Card>
        <Card title="Recent changes">
          <Timeline events={model.timeline} />
        </Card>
      </div>

      <ShowDetails summary="Show details">
        <h3 className="m-0 mb-2 text-base font-semibold">Agents A1 to A8</h3>
        <AgentPanel agents={model.agents} tf={tf} />
      </ShowDetails>
    </ControlRoomClient>
  );
}
