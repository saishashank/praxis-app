// Cortex page (M15 P4; CTX-071, CTX-072, CTX-073, ROL-107, D-295). Server component: plain tables from
// the already masked model of loaders/cortex.ts. Every signed-in role reads it; a masked viewer sees
// numbered strategies, angles and books and no amounts. The Owner controls (CTX-072) are links to
// the existing writers: parameter edits on Configuration (each one a charged trial that refits the
// maps) and the strategy switches on the risk page. There is no way here to edit a report or a
// statement, pass a gate by hand or take a strategy out of shadow.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Banner } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import {
  loadCortex,
  type AbstainReason,
  type FamilyView,
  type PassportView,
  type TickRowView,
} from "@/lib/ui/loaders/cortex";
import { formatCount, formatMicro } from "@/lib/view/format";
import { StrategyTabs } from "../strategies/StrategyTabs";

export const dynamic = "force-dynamic";

const PPM = 1_000_000; // threshold-ok: parts per million
const PERCENT = 100; // threshold-ok: percent
const MICRO = 1_000_000; // threshold-ok: micro per dollar

const STATUS_WORD: Record<string, string> = {
  shadow: "Shadow only (not trading)",
  allowed: "Allowed to trade",
  suspended: "Switched off",
};

const pct = (ppm: number | null, digits = 1) =>
  ppm === null ? (
    <NotMeasured />
  ) : (
    <span className="font-mono">{((ppm / PPM) * PERCENT).toFixed(digits)}%</span>
  );
const plain = (v: number | null, digits = 1) =>
  v === null ? <NotMeasured /> : <span className="font-mono">{v.toFixed(digits)}</span>;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card title={title} headingLevel={2} data-cortex-section={id} aria-label={title}>
      <div className="flex min-w-0 flex-col gap-3 text-sm">{children}</div>
    </Card>
  );
}

const familyCols: Column<FamilyView>[] = [
  { key: "name", header: "Strategy", cell: (r) => <span className="break-words">{r.name}</span> },
  { key: "status", header: "Status", cell: (r) => STATUS_WORD[r.status] ?? r.status },
  {
    key: "n",
    header: "Independent setups so far",
    align: "right",
    cell: (r) => plain(r.nEff, 0),
  },
  {
    key: "mde",
    header: "Smallest difference we could detect",
    align: "right",
    cell: (r) => (r.mde === null ? <NotMeasured /> : pct(Math.round(r.mde * PPM), 2)),
  },
];
const passportCols: Column<PassportView>[] = [
  { key: "angle", header: "Angle", cell: (r) => <span className="break-words">{r.angle}</span> },
  { key: "cluster", header: "Group", cell: (r) => r.cluster },
  { key: "status", header: "Status", cell: (r) => r.status },
  { key: "h", header: "Looks ahead (sessions)", align: "right", cell: (r) => r.horizonSessions },
];
const reasonCols: Column<AbstainReason>[] = [
  { key: "label", header: "Reason", cell: (r) => <span className="break-words">{r.label}</span> },
  { key: "n", header: "Book-nights", align: "right", cell: (r) => formatCount(r.count) },
];
const tickCols: Column<TickRowView>[] = [
  {
    key: "p",
    header: "Share price",
    align: "right",
    cell: (r) => `A$${(r.priceMicro / MICRO).toFixed(2)}`,
  },
  {
    key: "t",
    header: "Price step",
    align: "right",
    cell: (r) => `A$${(r.tickMicro / MICRO).toFixed(3)}`,
  },
  ...(["U1", "U2", "U3"] as const).map((t) => ({
    key: t,
    header: `Half spread, tier ${t.slice(1)}`,
    align: "right" as const,
    cell: (r: TickRowView) => pct(r.halfSpreadPpm[t] ?? null, 2),
  })),
];

export default async function CortexPage() {
  const user = await requireUser("read", "/cortex");
  const page = await loadCortex({ mainDb: mainDb(), authDb: authDb(), user });
  const v = page.data;
  const a = v.abstains;

  return (
    <main className="mx-auto flex max-w-4xl min-w-0 flex-col gap-6 px-4 py-6" data-cortex="">
      <StrategyTabs current="cortex" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Cortex</h1>
        <p className="m-0 text-sm text-text-muted" data-cortex-label="">
          {v.liveBooksLabel}. Every money figure is simulated.
        </p>
        <p className="m-0 text-xs text-text-muted">
          Times are Melbourne time with the daylight offset shown.
          {v.asOfMelbourne !== null ? ` Latest night: ${v.asOfMelbourne}.` : ""}
        </p>
      </header>

      {v.shadowOnly ? (
        <Banner tone="info" title="Shadow only">
          <span data-shadow-only="">{v.shadowOnlyText}</span>
        </Banner>
      ) : null}
      {v.refitPending ? (
        <Banner tone="info" title="Refit waiting">
          A setting was changed. The maps are refitted at the next fitting run.
        </Banner>
      ) : null}
      {page.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {page.text}
        </Banner>
      ) : null}

      <Section id="passports" title="Angles">
        <p className="m-0">
          {v.passports.total === 0 ? (
            <NotMeasured />
          ) : (
            `${v.passports.total} angles. ` +
            Object.entries(v.passports.byStatus)
              .map(([k, n]) => `${n} ${k}`)
              .join(", ") +
            "."
          )}
        </p>
        {v.passports.rows.length > 0 ? (
          <DataTable
            caption="Angles and their status"
            columns={passportCols}
            rows={v.passports.rows}
            rowKey={(r) => r.angle}
          />
        ) : null}
      </Section>

      <Section id="ledger" title="Ideas tried and luck">
        <p className="m-0" data-luck="">
          {v.ledger.cells === 0 && v.ledger.keyEdits === 0 ? <NotMeasured /> : v.ledger.luckText}
        </p>
        <p className="m-0 text-text-muted" data-error-levels="">
          {v.ledger.errorLevelsText}
        </p>
        <p className="m-0 text-text-muted">
          {formatCount(v.ledger.cells)} cells logged, {formatCount(v.ledger.keyEdits)} Owner setting
          edits counted as trials.
        </p>
      </Section>

      <Section id="families" title="Strategies and what we can detect">
        <DataTable
          caption="Strategy status with sample size and smallest detectable difference"
          columns={familyCols}
          rows={v.families}
          rowKey={(r) => r.name}
        />
        {v.families.some((f) => f.statement !== null) ? (
          <ul className="m-0 list-none p-0">
            {v.families
              .filter((f) => f.statement !== null)
              .map((f) => (
                <li key={f.name} className="break-words">
                  <strong>{f.name}:</strong> {f.statement}
                </li>
              ))}
          </ul>
        ) : null}
      </Section>

      <Section id="placebo" title="Placebo check">
        {v.placebo === null ? (
          <NotMeasured />
        ) : (
          <p className="m-0" data-placebo="">
            {v.placebo.passed ? "Passed" : "Failed"}: a random look-alike passed about{" "}
            {pct(v.placebo.nullPassRatePpm)} of the time. {v.placebo.at ?? ""}
          </p>
        )}
      </Section>

      <Section id="nav" title="Value at risk">
        {v.navAtRisk === null ? (
          <NotMeasured />
        ) : (
          <p className="m-0" data-nav-at-risk="">
            On a bad day (1 in 20) the books could lose about {plain(v.navAtRisk.loss95Pct, 1)}%;
            the worst day tested was {plain(v.navAtRisk.lossWorstPct, 1)}%. {v.navAtRisk.at ?? ""}
          </p>
        )}
      </Section>

      <Section id="abstain" title="Nights with no trade">
        {a.total === 0 ? (
          <NotMeasured />
        ) : (
          <>
            <p className="m-0">
              {formatCount(a.total)} book-nights without a trade in the last 60 days.
            </p>
            <DataTable
              caption="Reasons for no trade"
              columns={reasonCols}
              rows={a.reasons}
              rowKey={(r) => r.label}
            />
          </>
        )}
        <p className="m-0" data-comparator="">
          What the shadow arm would have done meanwhile:{" "}
          {a.shadowFilled === 0 ? (
            <NotMeasured />
          ) : (
            <>
              {formatCount(a.shadowFilled)} trades
              {a.shadowTotalNet !== null
                ? `, ${formatMicro(a.shadowTotalNet.micro)} after costs in total`
                : ""}
              .
            </>
          )}
        </p>
        <p className="m-0">
          Cash sitting idle: {a.idleSharePpm === null ? <NotMeasured /> : pct(a.idleSharePpm)} of
          book-nights.
        </p>
      </Section>

      <Section id="sector" title="Sector tilt (shadow only)">
        {v.sectorTilt === null ? (
          <NotMeasured />
        ) : (
          <ul className="m-0 list-none p-0">
            {v.sectorTilt.rows.map((r, i) => (
              <li key={`${r.book}:${r.sector}:${i}`}>
                {r.book}: {r.sector}, {r.tiltPp > 0 ? "+" : ""}
                {r.tiltPp} points
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="cold-start" title="Warming up">
        <p className="m-0" data-cold-start="">
          {v.coldStart.warming
            ? `Warming up: ${formatCount(v.coldStart.nights)} nights recorded and no map loaded yet.`
            : `${formatCount(v.coldStart.nights)} nights recorded since ${v.coldStart.firstD ?? ""}.`}
        </p>
      </Section>

      <Section id="opinion" title="Opinion track">
        {v.opinions.length === 0 ? (
          <NotMeasured />
        ) : (
          <ul className="m-0 list-none p-0">
            {v.opinions.map((o) => (
              <li key={o.kind}>
                {o.kind}: {formatCount(o.total)} recorded, {formatCount(o.settled)} settled
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="ticks" title="Price steps and costs">
        <DataTable
          caption="Price step and half spread by share price and liquidity tier"
          columns={tickCols}
          rows={v.tickCost}
          rowKey={(r) => String(r.priceMicro)}
        />
        <p className="m-0 text-text-muted">
          Half spreads are placeholders until checked against a quoted-spread source.
        </p>
      </Section>

      <Section id="controls" title="Owner controls">
        {v.controls.canEdit ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-owner-controls="">
            <li>
              <Link href={v.controls.killHref} className="text-accent underline">
                Switch a strategy off or on
              </Link>
            </li>
            <li>
              <Link href={v.controls.configHref} className="text-accent underline">
                Change a Cortex setting
              </Link>{" "}
              (each change counts as a trial and the maps are refitted)
            </li>
          </ul>
        ) : (
          <p className="m-0 text-text-muted">Only the Owner can change Cortex settings.</p>
        )}
        <p className="m-0 text-text-muted">
          Reports and statements cannot be edited, no check can be passed by hand and a strategy
          cannot leave shadow by hand.
        </p>
      </Section>
    </main>
  );
}
