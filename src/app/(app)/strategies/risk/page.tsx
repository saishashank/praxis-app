// Risk overview (UX-050, UX-051, UXN-104, UXN-150, UXN-152; docs/M7_design.md 3 row 14; D-128, D-129,
// D-135 draft). Every signed-in role reads the positions, the distance to the loss limit ("bust"), how
// concentrated the strategies are, the warning-sign status and the pre-computed overnight shock table.
// A masked viewer sees letters and weights, never a code, name, amount or stop level (DAT-124). The
// Owner can pause a strategy or switch a family off; an Editor sees the buttons disabled with the
// reason and a Viewer does not see them (UX-004). The server action refuses everyone else whatever this
// page shows. Nothing is computed in the request: shocks are read, never recomputed (UXN-152).
import { BreakerStatus } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Banner, EmptyState } from "@/components/ui/States";
import { Pill } from "@/components/ui/Pill";
import { Masked, Money, SimulatedLabel } from "@/components/ui/Values";
import { BustBar } from "@/components/charts";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import {
  loadRisk,
  type RiskStrategy,
  type RiskSwitch,
  type StressRow,
} from "@/lib/ui/loaders/risk";
import { formatMicro, formatPpm } from "@/lib/view/format";
import { StrategyTabs } from "../StrategyTabs";
import { setArenaControlAction } from "./actions";
import { ControlButton } from "./ControlButton";

export const dynamic = "force-dynamic";

const MICRO = 1_000_000; // threshold-ok: micro units per dollar, display only
const WIDTH_PCT = 100; // threshold-ok: percent

const STATE_WORDS = { enabled: "Running", paused: "Paused", killed: "Switched off" } as const;
const FLAG_WORDS = {
  safe: "Safe",
  caution: "Caution: close to the loss limit",
  bust: "Would reach the loss limit",
} as const;
const PILL_STATE = { enabled: "running", paused: "paused", killed: "stopped" } as const;
const OWNER_ONLY = "Only the Owner can pause or switch off a strategy.";

function StrategyCard({ s, nearPct }: { s: RiskStrategy; nearPct: number }) {
  return (
    <Card title={`${s.name} (${s.execution})`} headingLevel={3}>
      <dl className="m-0 mb-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-text-muted">Value now</dt>
          <dd className="m-0">
            <Money micro={s.nav.micro} />
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Invested</dt>
          <dd className="m-0 font-mono">{formatPpm(s.investedPpm)}</dd>
        </div>
      </dl>
      {s.bust === null ? (
        <p className="m-0 mb-3 text-sm text-text-muted">Loss limit not available.</p>
      ) : (
        <div className="mb-3">
          <BustBar
            nav={s.nav.micro / MICRO}
            seed={s.seed.micro / MICRO}
            bust={s.bust.micro / MICRO}
            nearPct={nearPct}
          />
        </div>
      )}
      {s.positions.length === 0 ? (
        <EmptyState compact motif="strategies" hue="strategies" title="No open positions." />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {s.positions.map((p) => (
            <li
              key={p.stock}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 p-2 text-sm"
            >
              <span className="min-w-0 font-semibold break-words">
                {p.stock}
                {p.held ? <span className="font-normal text-text-muted"> (held back)</span> : null}
              </span>
              <span className="font-mono">{formatPpm(p.weightPpm)} of value</span>
              <span>
                {p.stopDistancePpm === null
                  ? "No stop level"
                  : `${formatPpm(p.stopDistancePpm)} above its stop`}
              </span>
              <BreakerStatus status={p.breaker} />
              {p.value === null ? <Masked /> : <Money micro={p.value.micro} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SwitchRow({
  sw,
  scope,
  role,
}: {
  sw: RiskSwitch;
  scope: "execution" | "family";
  role: "owner" | "editor";
}) {
  const off = sw.state !== "enabled";
  const target = scope === "execution" ? (off ? "enabled" : "paused") : off ? "enabled" : "killed";
  const label =
    scope === "execution"
      ? off
        ? "Resume"
        : "Pause new entries"
      : off
        ? "Switch back on"
        : "Switch off";
  const title =
    target === "paused"
      ? `Pause ${sw.name}?`
      : target === "killed"
        ? `Switch off ${sw.name}?`
        : `Resume ${sw.name}?`;
  const description =
    target === "enabled"
      ? "New entries are allowed again from the next run."
      : "No new positions are opened from the next run. Open positions are still managed and close by their own rules. This is logged.";
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0 break-words">
        <strong>{sw.name}</strong> ({sw.key}){" "}
        <Pill kind="state" value={PILL_STATE[sw.state]}>
          {STATE_WORDS[sw.state]}
        </Pill>
        {sw.state === "enabled" && sw.effective !== "enabled"
          ? ` (${STATE_WORDS[sw.effective].toLowerCase()} by a wider switch)`
          : ""}
      </span>
      {role === "owner" ? (
        <ControlButton
          scope={scope}
          keyId={sw.key}
          state={target}
          subject={sw.name}
          label={label}
          title={title}
          description={description}
          confirmLabel={target === "enabled" ? "Confirm resume" : "Confirm"}
          danger={target !== "enabled"}
          action={setArenaControlAction}
        />
      ) : (
        <Button id={`${scope}-${sw.key}`} variant="secondary" disabledReason={OWNER_ONLY}>
          {label}
        </Button>
      )}
    </li>
  );
}

export default async function RiskPage() {
  const user = await requireUser("read", "/strategies/risk");
  const r = await loadRisk({ mainDb: mainDb(), authDb: authDb(), user });
  const d = r.data;
  const owner = can(user.role, "admin");
  const editor = user.role === "editor";

  const stressCols: Column<StressRow>[] = [
    {
      key: "move",
      header: "Market move",
      cell: (x) => (
        <span className="font-mono">
          {formatPpm(x.pct * 10_000, { sign: "always", digits: 0 })}
        </span>
      ), // threshold-ok: percent to ppm
    },
    {
      key: "pnl",
      header: "Simulated change in value",
      align: "right",
      cell: (x) => (
        <span data-money="" className="font-mono">
          {formatMicro(x.pnl.micro, { sign: "always" })}
        </span>
      ),
    },
    {
      key: "flag",
      header: "Flag",
      cell: (x) => (
        <span>
          {FLAG_WORDS[x.flag]}
          {x.affected > 0 ? ` (${x.affected} of ${d.strategies.length})` : ""}
        </span>
      ),
    },
  ];

  return (
    <main className="mx-auto flex max-w-5xl min-w-0 flex-col gap-6 px-4 py-6">
      <StrategyTabs current="risk" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Risk overview</h1>
        <p className="m-0 text-sm text-text-muted">
          Open positions of the practice strategies, how close each one is to its loss limit, and
          how concentrated they are. Information only: the strategies run on their own rules.
        </p>
        <SimulatedLabel />
      </header>

      {r.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {r.text}
        </Banner>
      ) : null}

      <section aria-labelledby="controls-h" className="flex flex-col gap-3">
        <h2 id="controls-h" className="m-0 text-xl font-semibold">
          Pause and switch-off
        </h2>
        {d.controls.length === 0 ? (
          <p className="m-0 text-sm">Every strategy is running.</p>
        ) : (
          <ul className="m-0 list-disc pl-5 text-sm">
            {d.controls.map((c) => (
              <li key={`${c.scope}:${c.key}`}>
                {c.scope === "market"
                  ? "The whole market"
                  : c.scope === "family"
                    ? "Family"
                    : "Strategy"}{" "}
                {c.scope === "market" ? "" : c.key}: {STATE_WORDS[c.state]}
              </li>
            ))}
          </ul>
        )}
        {owner || editor ? (
          <Card title="Owner controls" headingLevel={3}>
            <p className="m-0 mb-3 text-sm text-text-muted">
              Pausing stops new positions only. Open positions are still managed and close by their
              own rules. Every change asks for confirmation and is written to the audit log.
            </p>
            <h4 className="m-0 mb-2 text-sm font-semibold">Strategies</h4>
            {d.executions.length === 0 ? (
              <p className="m-0 mb-3 text-sm text-text-muted">No strategies yet.</p>
            ) : (
              <ul className="m-0 mb-4 flex list-none flex-col gap-3 p-0">
                {d.executions.map((e) => (
                  <SwitchRow
                    key={e.key}
                    sw={e}
                    scope="execution"
                    role={owner ? "owner" : "editor"}
                  />
                ))}
              </ul>
            )}
            <h4 className="m-0 mb-2 text-sm font-semibold">Families (kill switch)</h4>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {d.families.map((f) => (
                <SwitchRow key={f.key} sw={f} scope="family" role={owner ? "owner" : "editor"} />
              ))}
            </ul>
          </Card>
        ) : null}
      </section>

      <section aria-labelledby="positions-h" className="flex flex-col gap-3">
        <h2 id="positions-h" className="m-0 text-xl font-semibold">
          Positions and distance to the loss limit
        </h2>
        {d.strategies.length === 0 ? (
          <EmptyState motif="strategies" hue="strategies" title="No positions yet">
            {r.text}
          </EmptyState>
        ) : (
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {d.strategies.map((s) => (
              <StrategyCard key={s.execution} s={s} nearPct={d.nearPct} />
            ))}
          </div>
        )}
        {d.strategies.length > 0 && !d.breakersChecked ? (
          <p className="m-0 text-sm text-text-muted">
            Warning signs have not been checked for the latest day yet.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="conc-h" className="flex flex-col gap-3">
        <h2 id="conc-h" className="m-0 text-xl font-semibold">
          Concentration
        </h2>
        {d.concentration.length === 0 ? (
          <EmptyState
            compact
            motif="strategies"
            hue="strategies"
            title="Nothing is held at the moment."
          />
        ) : (
          <Card>
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {d.concentration.map((c) => (
                <li key={c.stock} className="min-w-0 break-words">
                  <span className="font-semibold">{c.stock}</span>:{" "}
                  <span className="font-mono">{formatPpm(c.weightPpm)}</span> of all value, in{" "}
                  {c.strategies} {c.strategies === 1 ? "strategy" : "strategies"}
                  <div
                    aria-hidden="true"
                    className="mt-1 h-2 rounded bg-chart-1"
                    style={{ width: `${Math.min(WIDTH_PCT, Math.round(c.weightPpm / 10_000))}%` }} // threshold-ok: ppm to percent
                  />
                </li>
              ))}
            </ul>
            <p className="mt-3 mb-0 text-xs text-text-muted">
              Information only: the strategies are independent and do not look at each other.
            </p>
          </Card>
        )}
      </section>

      <section aria-labelledby="stress-h" className="flex flex-col gap-3">
        <h2 id="stress-h" className="m-0 text-xl font-semibold">
          Stress test
        </h2>
        <p className="m-0 text-sm text-text-muted">
          What the open positions would be worth if every share moved by the same amount. Worked out
          overnight from the stored positions, not live and not a forecast.
        </p>
        <DataTable
          caption="Simulated change in value under a market move"
          columns={stressCols}
          rows={d.stress}
          rowKey={(x) => String(x.pct)}
          empty={
            <EmptyState motif="strategies" hue="strategies" title="No stress test yet">
              The shock table is written overnight once strategies hold positions.
            </EmptyState>
          }
        />
      </section>
    </main>
  );
}
