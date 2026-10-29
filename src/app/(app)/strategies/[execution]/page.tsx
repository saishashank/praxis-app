// One strategy = execution detail (UX-030 to UX-032, UXN-051, UXN-054, UXN-055, UXN-068, ARN-049,
// ARN-050; docs/M7_design.md 3 row 12). Every role may read it. A masked viewer sees the trade strip with
// letters, weeks and no prices, and no markers on the chart; the Owner (or a user with an unmask grant)
// sees codes, dates and prices. Only the Owner gets a working "Revert" button, which posts to the
// existing audited Owner route (D-125). All figures are stored rows; missing ones say "Not measured yet".
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadStrategyDetail, type PastRound } from "@/lib/ui/loaders/strategies";
import {
  drawdownPpm,
  loadStrategyExtras,
  type EvidenceRow,
  type SleeveLegView,
  type VersionRow,
} from "@/lib/ui/loaders/strategyViews";
import { loadRobustness } from "@/lib/ui/loaders/robustness";
import { CifTable, type CifRow } from "@/components/charts/Cif";
import { RegimeBadge, ValidationBadge } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { KpiRow, KpiTile } from "@/components/ui/Kpi";
import { Term } from "@/components/ui/Overlays";
import { Banner, EmptyState, ShowDetails } from "@/components/ui/States";
import { Pill } from "@/components/ui/Pill";
import { GainLoss, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDate, formatMicro, formatPpm, gainLossGlyph } from "@/lib/view/format";
import { NavBar } from "../NavBar";
import { OutcomeBars } from "../OutcomeBars";
import { StrategyTabs } from "../StrategyTabs";
import { tileState } from "../state";
import { RevertVersion } from "./RevertVersion";
import { Robustness } from "./Robustness";
import { StrategyChart, type ChartControl, type ChartTrade } from "./StrategyChart";

export const dynamic = "force-dynamic";

const MICRO_PER_CENT = 10_000; // threshold-ok: micro-AUD to cents
const PPM_PER_PERCENT = 10_000; // threshold-ok: ppm to percent

const dollars = (micro: number): number => Math.round(micro / MICRO_PER_CENT) / 100;

const ENDED: Record<string, string> = {
  target: "Reached the goal",
  bust: "Hit the loss limit",
  stalled: "Stalled below the floor",
  timeout: "Ran out of time",
};

const ORIGIN: Record<string, string> = {
  seed: "Starting version",
  challenger: "Promoted from a challenger",
  owner: "Written by the Owner",
  rollback: "Rolled back to an earlier version",
  force: "Applied by the Owner without the usual test",
};

const LEDGER: Record<string, string> = {
  promotion: "Promotion",
  force_apply: "Forced change",
  rollback: "Roll-back",
  owner_version: "Owner version",
  retire: "Retired",
  kill_freeze: "Kill-switch freeze",
  lane_a_playbook: "Playbook update",
  lane_a_note: "Playbook note",
  lesson_force: "Lesson forced",
};

function cifRowsOf(ev: EvidenceRow | null): CifRow[] {
  if (!ev) return [];
  return ev.cif.map((r) => ({
    month: r.month,
    target: { month: r.month, ...r.target },
    bust: { month: r.month, ...r.bust },
    stalled: { month: r.month, ...r.stalled },
  }));
}

function Leg({ title, leg }: { title: string; leg: SleeveLegView | null }) {
  return (
    <Card title={title} headingLevel={4}>
      {leg ? (
        <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-text-muted">Sleeve trades</dt>
          <dd className="m-0 text-right font-mono">{leg.sleeveTrades}</dd>
          <dt className="text-text-muted">Practice trades (shadow)</dt>
          <dd className="m-0 text-right font-mono">{leg.shadowTrades}</dd>
          <dt className="text-text-muted">Forced closes</dt>
          <dd className="m-0 text-right font-mono">{leg.closeouts}</dd>
          <dt className="text-text-muted">Lock episodes</dt>
          <dd className="m-0 text-right font-mono">{leg.locks}</dd>
          <dt className="text-text-muted">Net profit or loss</dt>
          <dd className="m-0 text-right">
            {leg.netPl ? (
              <GainLoss value={leg.netPl.micro} kind="cents">
                {formatMicro(leg.netPl.micro, { sign: "always" })}
              </GainLoss>
            ) : (
              <NotMeasured />
            )}
          </dd>
          <dt className="text-text-muted">Value change vs start</dt>
          <dd className="m-0 text-right">
            {leg.navMinusSeed ? (
              <>
                <Money micro={leg.navMinusSeed.meanMicro} sign="always" />
                <span className="block text-xs text-text-muted">
                  90% range {formatMicro(leg.navMinusSeed.lowerMicro, { sign: "always" })} to{" "}
                  {formatMicro(leg.navMinusSeed.upperMicro, { sign: "always" })},{" "}
                  {leg.navMinusSeed.n} rounds
                </span>
              </>
            ) : (
              <NotMeasured />
            )}
          </dd>
        </dl>
      ) : (
        <NotMeasured>No sleeve figures stored yet</NotMeasured>
      )}
    </Card>
  );
}

const MIN_ROUNDS = 3; // threshold-ok: the card text names 3 separate finished rounds

export default async function StrategyPage({ params }: { params: Promise<{ execution: string }> }) {
  const { execution: raw } = await params;
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  const user = await requireUser("read", `/strategies/${encodeURIComponent(id)}`);
  const deps = { mainDb: mainDb(), authDb: authDb(), user: { id: user.id, role: user.role } };
  const detail = await loadStrategyDetail(deps, id);
  if (!detail.data.found) notFound();
  const d = detail.data;
  const tile = d.tile;
  const ex = await loadStrategyExtras(
    deps,
    id,
    d.navSeries.map((p) => p.d),
  );

  // M14 (D-251): Owner and Editor only; the loader reads nothing for any other role
  const robustness = await loadRobustness(deps, id);

  const navPoints = d.navSeries.map((p) => ({ time: p.d, value: dollars(p.nav) }));
  const ddPpm = drawdownPpm(d.navSeries.map((p) => p.nav));
  const maxDropPpm = ddPpm.length > 0 ? Math.min(...ddPpm) : 0;
  const drawdown = d.navSeries.map((p, i) => ({ time: p.d, value: ddPpm[i]! / PPM_PER_PERCENT }));
  const maxDropText =
    d.navSeries.length < 2
      ? "Not measured yet: a round needs at least two sessions."
      : `Largest drop so far in this round: ${formatPpm(maxDropPpm)}. The typical and 95th-percentile drops of replayed rounds are not measured yet.`;

  const trades: ChartTrade[] = ex.trades.map((t) => ({
    key: t.key,
    stock: t.stock,
    entryDate: t.entryDate,
    exitDate: t.exitDate,
    entryDay: t.entryDay,
    exitDay: t.exitDay,
    qty: t.qty,
    open: t.open,
    returnText:
      t.returnPpm === null
        ? null
        : `${gainLossGlyph(t.returnPpm)} ${formatPpm(t.returnPpm, { sign: "always" })}`,
    pnlText: t.pnl ? formatMicro(t.pnl.micro, { sign: "always" }) : null,
    entryPriceText: t.entryPrice ? formatMicro(t.entryPrice.micro) : null,
    exitPriceText: t.exitPrice ? formatMicro(t.exitPrice.micro) : null,
    cardHref: t.cardHref,
  }));
  const controls: ChartControl[] = ex.controls.map((c) => ({
    id: c.id,
    label: c.label,
    points: c.points.map((p) => ({ time: p.d, value: dollars(p.nav) })),
  }));
  const seedMicro = tile?.seed?.micro ?? null;
  const zeroEdge =
    ex.zeroEdge && ex.zeroEdge.meanNavMinusSeedMicro !== null && seedMicro !== null
      ? {
          level: dollars(seedMicro + ex.zeroEdge.meanNavMinusSeedMicro),
          text: `Zero-edge benchmark (long dashes): expected end value ${formatMicro(seedMicro + ex.zeroEdge.meanNavMinusSeedMicro)}`,
        }
      : null;

  const isOwner = user.role === "owner";
  const isEditor = user.role === "editor";
  const liveVersion = ex.versions.find((v) => v.live)?.id ?? d.ruleVersion;
  const openTrades = ex.trades.filter((t) => t.open);
  const closedTrades = ex.trades.flatMap((t) =>
    !t.open && t.returnPpm !== null ? [{ key: t.key, stock: t.stock, returnPpm: t.returnPpm }] : [],
  );
  // D-200: with fewer than 3 separate finished rounds the chances are not shown (0% with a 0-100%
  // range looks like a result); the card says what is needed instead
  const ev = ex.evidence && (ex.evidence.effectiveN ?? 0) >= MIN_ROUNDS ? ex.evidence : null;
  const cifRows = cifRowsOf(ev);
  const last12 = cifRows[cifRows.length - 1];

  const roundCols: Column<PastRound>[] = [
    { key: "round", header: "Round", cell: (r) => `Round ${r.round}` },
    { key: "started", header: "Started", cell: (r) => formatDate(r.startD) },
    {
      key: "ended",
      header: "How it ended",
      cell: (r) =>
        r.terminalKind
          ? `${ENDED[r.terminalKind] ?? r.terminalKind}, ${formatDate(r.terminalD)}`
          : "In progress",
    },
    {
      key: "sessions",
      header: "Sessions held",
      align: "right",
      cell: (r) =>
        r.sessions === null ? <NotMeasured /> : <span className="font-mono">{r.sessions}</span>,
    },
    {
      key: "final",
      header: "Final value",
      align: "right",
      cell: (r) =>
        r.outcome ? <Money micro={r.outcome.micro} /> : <NotMeasured>Not final yet</NotMeasured>,
    },
  ];

  const versionCols: Column<VersionRow>[] = [
    { key: "version", header: "Version", cell: (v) => <span className="font-mono">{v.id}</span> },
    { key: "date", header: "Date", cell: (v) => formatDate(v.registeredD) },
    {
      key: "action",
      header: "What happened",
      cell: (v) => `${ORIGIN[v.origin] ?? v.origin}${v.live ? " (in use now)" : ""}`,
    },
    {
      key: "test",
      header: "Test result",
      cell: (v) =>
        v.validation ? (
          <span className="font-mono">{v.validation}</span>
        ) : (
          <NotMeasured>Not tested</NotMeasured>
        ),
    },
    {
      key: "revert",
      header: "Revert",
      hideInCard: !isOwner && !isEditor,
      cell: (v) =>
        !v.revertable ? (
          <span className="text-text-muted">{v.live ? "In use" : "Not available"}</span>
        ) : isOwner ? (
          <RevertVersion family={ex.family ?? ""} versionId={v.id} />
        ) : isEditor ? (
          <Button disabledReason="Only the Owner can revert a version.">Revert</Button>
        ) : null,
    },
  ];

  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-6">
      <StrategyTabs current="overview" />
      <header
        data-sticky-header=""
        className="sticky top-14 z-20 -mx-4 flex min-w-0 flex-col gap-2 border-b border-border bg-bg px-4 py-3"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h1 className="m-0 text-2xl font-semibold">{d.name}</h1>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {tile?.nav ? (
              <span className="font-mono text-lg" data-header-nav="">
                <Money micro={tile.nav.micro} />
              </span>
            ) : null}
            {tile && tileState(tile) ? (
              <Pill kind="state" value={tileState(tile) as string} />
            ) : null}
          </div>
        </div>
        {tile?.nav ? (
          <NavBar
            label={d.name ?? "Strategy"}
            navCents={Math.round(tile.nav.micro / MICRO_PER_CENT)}
            startCents={tile.seed ? Math.round(tile.seed.micro / MICRO_PER_CENT) : undefined}
            minCents={tile.bust ? Math.round(tile.bust.micro / MICRO_PER_CENT) : undefined}
            maxCents={tile.target ? Math.round(tile.target.micro / MICRO_PER_CENT) : undefined}
          />
        ) : null}
        <p className="m-0 text-sm text-text-muted">
          {tile?.moneyType}
          {d.oneLiner ? ` · ${d.oneLiner}` : ""}
        </p>
        {tile?.hasCohort ? (
          <p className="m-0 text-base">
            Round {tile.round} · started {formatDate(tile.startD)} · {tile.sessions}{" "}
            {tile.sessions === 1 ? "session" : "sessions"} held
          </p>
        ) : (
          <p className="m-0 text-base">
            <NotMeasured>No round has started yet</NotMeasured>
          </p>
        )}
        <SimulatedLabel />
        <div className="flex flex-wrap items-start gap-2">
          <RegimeBadge regime={tile?.regime} />
          {ex.label ? (
            <>
              <ValidationBadge label={ex.label.label} possibleLuck={ex.label.possibleLuck} />
              <span className="text-sm text-text-muted">
                Based on {ex.label.n} results
                {ex.label.mde !== null
                  ? `; smallest edge it could detect ${formatPpm(Math.round(ex.label.mde * 1_000_000))}`
                  : ""}
              </span>
            </>
          ) : (
            <NotMeasured>No evidence label yet</NotMeasured>
          )}
          {ex.label?.costInfeasible ? (
            <span className="text-sm">Costs may be too high for this strategy.</span>
          ) : null}
        </div>
      </header>

      {detail.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {detail.text}
        </Banner>
      ) : null}

      {!tile?.hasCohort ? (
        <EmptyState motif="strategies" hue="strategies" title="Nothing to chart yet">
          {detail.text}
        </EmptyState>
      ) : (
        <>
          <KpiRow label="Where this round stands">
            <KpiTile
              label="Value now"
              value={tile.nav ? <Money micro={tile.nav.micro} /> : null}
              currency="AUD"
            />
            <KpiTile
              label="Change since start"
              value={
                tile.returnPpm === null ? null : <GainLoss value={tile.returnPpm} kind="ppm" />
              }
            />
            <KpiTile
              label="Loss limit"
              value={tile.bust ? <Money micro={tile.bust.micro} /> : null}
              currency="AUD"
            />
            <KpiTile
              label="Goal"
              value={tile.target ? <Money micro={tile.target.micro} /> : null}
              currency="AUD"
            />
          </KpiRow>

          <Card title="Value over time" headingLevel={2}>
            <StrategyChart
              name={d.name ?? "Strategy"}
              nav={navPoints}
              regimes={ex.regimes}
              controls={controls}
              zeroEdge={zeroEdge}
              lines={{
                seed: seedMicro === null ? null : dollars(seedMicro),
                bust: tile.bust ? dollars(tile.bust.micro) : null,
                target: tile.target ? dollars(tile.target.micro) : null,
              }}
              trades={trades}
              showMarkers={!detail.masked}
              drawdown={drawdown}
              maxDropText={maxDropText}
            />
          </Card>
        </>
      )}

      <Card title="Open positions" headingLevel={2}>
        {openTrades.length === 0 ? (
          <EmptyState compact motif="strategies" hue="strategies" title="No open positions." />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {openTrades.map((t) => (
              <li
                key={t.key}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 p-2 text-sm"
              >
                <span className="min-w-0 font-semibold break-words">{t.stock}</span>
                <span>
                  {t.qty} {t.qty === 1 ? "share" : "shares"}
                </span>
                <span className="text-text-muted">since {t.entryDay ?? "an earlier session"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Rules in force" headingLevel={2}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          <li>
            Rule version in use:{" "}
            {detail.masked ? (
              "the current one"
            ) : (
              <span className="font-mono">{liveVersion ?? "n/a"}</span>
            )}
          </li>
          {d.costProfile && !detail.masked ? <li>Cost profile: {d.costProfile}</li> : null}
          <li>Pausing stops new entries only; open positions close by their own rules.</li>
        </ul>
      </Card>

      <Card title="Outcomes so far" headingLevel={2}>
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0 text-sm text-text-muted">
            {closedTrades.length} closed {closedTrades.length === 1 ? "trade" : "trades"} in this
            round, by return. Simulated.
          </p>
          <OutcomeBars items={closedTrades} />
        </div>
      </Card>

      <Card title="Compared with matched controls" headingLevel={2}>
        {ev ? (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="m-0 text-sm text-text-muted">
              Based on {ev.effectiveN ?? 0} separate finished rounds (
              <Term
                meaning="Effective N is the number of finished rounds that do not overlap in time. Overlapping rounds are counted once, so the ranges are not too narrow."
                official="Effective N"
              >
                effective N
              </Term>
              ). Chances are shares of those rounds, with 90% ranges.
            </p>
            <KpiRow label="Strategy against its matched control">
              <KpiTile
                label="Chance of reaching the goal in 12 months"
                value={last12 ? `${(last12.target.p * 100).toFixed(1)}%` : null}
                note={
                  last12?.target.lo !== undefined
                    ? `90% range ${(last12.target.lo * 100).toFixed(1)}% to ${(last12.target.hi! * 100).toFixed(1)}%`
                    : undefined
                }
              />
              <KpiTile
                label="Chance vs matched control C2"
                value={
                  ev.cifTargetMinusC2 === null
                    ? null
                    : `${ev.cifTargetMinusC2 >= 0 ? "+" : "-"}${(Math.abs(ev.cifTargetMinusC2) * 100).toFixed(1)} points`
                }
              />
              <KpiTile
                label="Average value change vs start"
                value={
                  ev.navMinusSeed ? <Money micro={ev.navMinusSeed.meanMicro} sign="always" /> : null
                }
              />
              <KpiTile
                label="Value change vs matched control C2"
                value={
                  ev.minusC2Micro === null ? null : <Money micro={ev.minusC2Micro} sign="always" />
                }
              />
            </KpiRow>
            {ex.zeroEdge ? (
              <p className="m-0 text-sm">
                Zero-edge benchmark: a made-up strategy with no skill, but the same swings, costs
                and rules, reaches the goal in {(ex.zeroEdge.target * 100).toFixed(1)}% of{" "}
                {ex.zeroEdge.trials} trials.
              </p>
            ) : (
              <p className="m-0 text-sm">
                Zero-edge benchmark: <NotMeasured />
              </p>
            )}
            {cifRows.length > 0 ? <CifTable rows={cifRows} /> : null}
          </div>
        ) : (
          <p className="m-0 text-sm">
            <NotMeasured>These figures need at least 3 separate finished rounds</NotMeasured>
          </p>
        )}
      </Card>

      <Robustness view={robustness} />

      <Card title="Past rounds" headingLevel={2}>
        <DataTable
          caption="Rounds of this strategy, newest first"
          columns={roundCols}
          rows={d.pastRounds}
          rowKey={(r) => String(r.round)}
          empty={<EmptyState compact motif="strategies" hue="strategies" title="No rounds yet." />}
        />
      </Card>

      {d.variant === "L" ? (
        <Card title="Leverage sleeve" headingLevel={2}>
          <div className="flex min-w-0 flex-col gap-3">
            {d.sleeve ? (
              <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-text-muted">State</dt>
                <dd className="m-0 text-right">
                  {d.sleeve.state === "locked" ? "Locked while it recovers" : "Unlocked"}
                </dd>
                <dt className="text-text-muted">Since</dt>
                <dd className="m-0 text-right">{formatDate(d.sleeve.sinceD)}</dd>
                <dt className="text-text-muted">Loss to win back</dt>
                <dd className="m-0 text-right">
                  <Money micro={d.sleeve.lossToRecover.micro} />
                </dd>
                <dt className="text-text-muted">Open sleeve trades</dt>
                <dd className="m-0 text-right font-mono">{d.sleeve.openTrades}</dd>
              </dl>
            ) : (
              <p className="m-0 text-sm">
                <NotMeasured>No sleeve activity yet</NotMeasured>
              </p>
            )}
            <p className="m-0 text-sm font-semibold">
              Hypothetical leverage (simulated, not real broker leverage)
            </p>
            <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
              <Leg title="Designed leverage (10 times)" leg={ex.sleeve?.levered ?? null} />
              <Leg title="Reality-adjusted (5 times)" leg={ex.sleeve?.reality ?? null} />
            </div>
            <p className="m-0 text-xs text-text-muted">
              Win rate, net expectancy, costs, financing and how much of the sleeve is used: Not
              measured yet.
            </p>
          </div>
        </Card>
      ) : null}

      <Card title="Rule version and changes" headingLevel={2}>
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0 text-sm">
            Rule version in use: <span className="font-mono">{liveVersion ?? "n/a"}</span>.{" "}
            <Link href="/reviews/learned" className="text-accent underline">
              What the system learned
            </Link>
          </p>
          {tile && tile.attention.length > 0 ? (
            <p className="m-0 text-sm">Needs a look: {tile.attention.join("; ")}.</p>
          ) : null}
          {ex.pendingChallengers.length > 0 ? (
            <div>
              <p className="m-0 text-sm font-semibold">Challengers waiting for this strategy</p>
              <ul className="m-0 list-disc pl-5 text-sm">
                {ex.pendingChallengers.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/reviews/learned/challengers/${encodeURIComponent(c.id)}`}
                      className="text-accent underline"
                    >
                      {c.id}
                    </Link>{" "}
                    ({c.state})
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState
              compact
              motif="strategies"
              hue="strategies"
              title="No challengers are waiting."
            />
          )}
          <h3 className="m-0 text-base font-semibold">Version history</h3>
          <DataTable
            caption="Versions of this strategy's rules, newest first"
            columns={versionCols}
            rows={ex.versions}
            rowKey={(v) => v.id}
            empty={
              <EmptyState
                compact
                motif="strategies"
                hue="strategies"
                title="No versions are stored yet."
              />
            }
          />
          {isOwner ? (
            <p className="m-0 text-xs text-text-muted">
              Reverting schedules an earlier version for the next restart. It is recorded in the
              audit log.
            </p>
          ) : null}
          {ex.ledger.length > 0 ? (
            <ShowDetails summary="Change ledger for this strategy">
              <ul className="m-0 list-disc pl-5 text-sm">
                {ex.ledger.map((l, i) => (
                  <li key={`${l.effectiveD}-${i}`}>
                    {LEDGER[l.kind] ?? l.kind}, {formatDate(l.effectiveD)}
                  </li>
                ))}
              </ul>
            </ShowDetails>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
