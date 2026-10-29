// Leaderboard (UX-020 to UX-023, ARN-071, ARN-078, UXN-053, UXN-057, UXN-060; docs/M7_design.md 3 row 13).
// Every role may read it; rows carry no stock code. Strategies whose 90% ranges overlap are shown as one
// TIED group and never put in order; the order inside a group is alphabetical, never by the point
// estimate (UX-020). Strategies without enough finished rounds (effective N below 3) sit under
// "Not enough evidence yet". All figures are stored rows; a missing one says "Not measured yet".
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadLeaderboard, loadStrategies, type LeaderRow } from "@/lib/ui/loaders/strategies";
import {
  labelRank,
  loadLeaderEvidence,
  parseRegime,
  REGIME_STATES,
  type CifPoint,
  type EvidenceRow,
  type LabelView,
  type RegimeState,
  type ZeroEdgeView,
} from "@/lib/ui/loaders/strategyViews";
import { Sparkline } from "@/components/charts/Sparkline";
import { CifTable, type CifRow } from "@/components/charts/Cif";
import { RegimeBadge, ValidationBadge } from "@/components/ui/Badges";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chips, type NavItem } from "@/components/ui/Nav";
import { Term } from "@/components/ui/Overlays";
import { Banner, EmptyState, ShowDetails } from "@/components/ui/States";
import { GainLoss, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { regimeLabel } from "@/lib/view/terms";
import { formatMicro } from "@/lib/view/format";
import { StrategyTabs } from "../StrategyTabs";

export const dynamic = "force-dynamic";

const MICRO_PER_CENT = 10_000; // threshold-ok: micro-AUD to cents

type Row = {
  id: string;
  name: string;
  leader: LeaderRow;
  label: LabelView | null;
  ev: EvidenceRow | null;
  zero: ZeroEdgeView | null;
  spark: number[];
  regimeRounds: {
    rounds: number;
    target: number;
    bust: number;
    stalled: number;
    timeout: number;
  } | null;
};

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;
const chance = (c: CifPoint | undefined): string =>
  c === undefined
    ? "Not measured yet"
    : c.lo !== undefined && c.hi !== undefined
      ? `${pct(c.p)} (${pct(c.lo)} to ${pct(c.hi)})`
      : `${pct(c.p)} (range not measured)`;

function cifRowsOf(ev: EvidenceRow): CifRow[] {
  return ev.cif.map((r) => ({
    month: r.month,
    target: { month: r.month, ...r.target },
    bust: { month: r.month, ...r.bust },
    stalled: { month: r.month, ...r.stalled },
  }));
}

function columns(cost: string | null, regime: RegimeState | null): Column<Row>[] {
  const cols: Column<Row>[] = [
    {
      key: "strategy",
      header: "Strategy",
      cell: (r) => (
        <Link href={`/strategies/${encodeURIComponent(r.id)}`} className="text-accent underline">
          {r.name}
        </Link>
      ),
    },
    {
      key: "label",
      header: "Evidence label",
      cell: (r) =>
        r.label ? (
          <span className="flex flex-col items-start gap-1">
            <ValidationBadge label={r.label.label} possibleLuck={r.label.possibleLuck} />
            <span className="text-xs text-text-muted">
              n {r.label.n}
              {r.label.mde !== null
                ? `, smallest edge it could detect ${(r.label.mde * 100).toFixed(2)}%`
                : ""}
            </span>
          </span>
        ) : (
          <NotMeasured>No label yet</NotMeasured>
        ),
    },
    {
      key: "rounds",
      header: regime ? `Rounds started in ${regimeLabel(regime).shown}` : "Rounds",
      align: "right",
      cell: (r) => {
        const x =
          r.regimeRounds ??
          (regime ? { rounds: 0, target: 0, bust: 0, stalled: 0, timeout: 0 } : null);
        const l = r.leader;
        return (
          <span className="flex flex-col items-end text-sm">
            <span className="font-mono">
              {x ? x.rounds : l.rounds} total
              {x ? "" : `, ${l.finished} finished`}
            </span>
            <span className="text-xs text-text-muted">
              Goal {x ? x.target : l.reachedTarget}, loss limit {x ? x.bust : l.busted}, stalled{" "}
              {x ? x.stalled : l.stalled}
            </span>
            {r.ev?.effectiveN !== null && r.ev?.effectiveN !== undefined ? (
              <span className="text-xs text-text-muted">
                <Term
                  meaning="Effective N is the number of finished rounds that do not overlap in time. Overlapping rounds are counted once."
                  official="Effective N"
                >
                  Separate rounds
                </Term>
                : {r.ev.effectiveN}
              </span>
            ) : (
              <span className="text-xs text-text-muted">Separate rounds: not measured yet</span>
            )}
          </span>
        );
      },
    },
    {
      key: "chances",
      header: "Chance of ending (12 months)",
      cell: (r) => {
        const last = r.ev?.cif[r.ev.cif.length - 1];
        return last ? (
          <span className="flex flex-col gap-1 text-sm">
            <span>Goal {chance(last.target)}</span>
            <span>Loss limit {chance(last.bust)}</span>
            <span>Stalled {chance(last.stalled)}</span>
            <ShowDetails summary="3, 6 and 12 months">
              <CifTable rows={cifRowsOf(r.ev!)} />
            </ShowDetails>
          </span>
        ) : (
          <NotMeasured />
        );
      },
    },
    {
      key: "value",
      header: "Value change vs start",
      align: "right",
      cell: (r) =>
        r.ev?.navMinusSeed ? (
          <span className="flex flex-col items-end text-sm">
            <GainLoss value={r.ev.navMinusSeed.meanMicro} kind="cents">
              {formatMicro(r.ev.navMinusSeed.meanMicro, { sign: "always" })}
            </GainLoss>
            <span className="text-xs text-text-muted">
              Minus matched control C2:{" "}
              {r.ev.minusC2Micro === null
                ? "Not measured yet"
                : formatMicro(r.ev.minusC2Micro, { sign: "always" })}
            </span>
          </span>
        ) : (
          <NotMeasured />
        ),
    },
    {
      key: "zero",
      header: "Zero-edge benchmark",
      align: "right",
      cell: (r) =>
        r.zero ? <span className="font-mono">Goal {pct(r.zero.target)}</span> : <NotMeasured />,
    },
    {
      key: "cost",
      header: cost ? `Value under cost profile ${cost}` : "Costs",
      align: "right",
      cell: (r) =>
        cost ? (
          r.leader.recostNav ? (
            <Money micro={r.leader.recostNav.micro} />
          ) : (
            <NotMeasured />
          )
        ) : r.label?.costInfeasible ? (
          <span className="text-sm">May cost too much</span>
        ) : (
          <span className="text-sm">No cost warning</span>
        ),
    },
    {
      key: "drop",
      header: "Largest drop",
      align: "right",
      cell: () => <NotMeasured />,
    },
    {
      key: "trend",
      header: "Recent trend",
      cell: (r) =>
        r.spark.length >= 2 ? (
          <Sparkline values={r.spark} label={`${r.name} value, last ${r.spark.length} sessions`} />
        ) : (
          <NotMeasured />
        ),
    },
  ];
  return cols;
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser("read", "/strategies/leaderboard");
  const regime = parseRegime(typeof sp.regime === "string" ? sp.regime : null);
  const deps = { mainDb: mainDb(), authDb: authDb(), user: { id: user.id, role: user.role } };
  const [lb, evidence, list] = await Promise.all([
    loadLeaderboard(deps, { cost: typeof sp.cost === "string" ? sp.cost : null }),
    loadLeaderEvidence(deps, { regime }),
    loadStrategies(deps),
  ]);
  const cost = lb.data.cost;
  const sparkOf = new Map(
    list.data.tiles.map((t) => [
      t.execution,
      t.spark.map((m) => Math.round(m / MICRO_PER_CENT) / 100),
    ]),
  );
  const mood = list.data.tiles.find((t) => t.regime)?.regime ?? null;

  const rows = new Map<string, Row>();
  for (const l of lb.data.strategies) {
    rows.set(l.execution, {
      id: l.execution,
      name: l.name,
      leader: l,
      label:
        evidence.labels[l.execution] ??
        (l.label
          ? { label: l.label, n: 0, mde: null, possibleLuck: false, costInfeasible: false }
          : null),
      ev: evidence.rows[l.execution] ?? null,
      zero: evidence.zeroEdge[l.execution] ?? null,
      spark: sparkOf.get(l.execution) ?? [],
      regimeRounds: evidence.regimeRounds ? (evidence.regimeRounds[l.execution] ?? null) : null,
    });
  }
  const byName = (a: Row, b: Row): number =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);

  // ARN-078: ranked groups (tied or alone), the group with the best label first; inside a group A to Z.
  const groups = (evidence.groups ?? [])
    .map((g) => ({
      rank: g.rank,
      tied: g.tied,
      members: g.members
        .map((m) => rows.get(m))
        .filter((r): r is Row => r !== undefined)
        .sort(byName),
    }))
    .filter((g) => g.members.length > 0)
    .map((g) => ({
      ...g,
      best: Math.min(...g.members.map((m) => labelRank(m.label?.label ?? null))),
    }))
    .sort((a, b) => a.best - b.best || a.rank - b.rank);
  const ranked = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const insufficient = [...rows.values()]
    .filter((r) => !ranked.has(r.id))
    .sort(
      (a, b) =>
        labelRank(a.label?.label ?? null) - labelRank(b.label?.label ?? null) || byName(a, b),
    );
  const compared = ranked.size;

  const q = (over: { cost?: string | null; regime?: string | null }): string => {
    const p = new URLSearchParams();
    const c = over.cost === undefined ? cost : over.cost;
    const r = over.regime === undefined ? regime : over.regime;
    if (c) p.set("cost", c);
    if (r) p.set("regime", r);
    const s = p.toString();
    return s ? `/strategies/leaderboard?${s}` : "/strategies/leaderboard";
  };
  const regimeChips: NavItem[] = [
    { href: q({ regime: null }), label: "All market moods", current: regime === null },
    ...REGIME_STATES.map((s) => ({
      href: q({ regime: s }),
      label: regimeLabel(s).shown,
      current: regime === s,
    })),
  ];
  const costChips: NavItem[] = [
    { href: q({ cost: null }), label: "As traded", current: cost === null },
    ...lb.data.costKeys.map((k) => ({
      href: q({ cost: k }),
      label: k === "stress" ? "Stress" : k,
      current: cost === k,
    })),
  ];
  const cols = columns(cost, regime);
  const ctl: Column<LeaderRow>[] = [
    { key: "name", header: "Control", cell: (c) => c.name },
    {
      key: "rounds",
      header: "Rounds",
      align: "right",
      cell: (c) => <span className="font-mono">{c.rounds}</span>,
    },
    {
      key: "fin",
      header: "Finished",
      align: "right",
      cell: (c) => <span className="font-mono">{c.finished}</span>,
    },
    {
      key: "goal",
      header: "Reached goal",
      align: "right",
      cell: (c) => <span className="font-mono">{c.reachedTarget}</span>,
    },
    {
      key: "bust",
      header: "Hit loss limit",
      align: "right",
      cell: (c) => <span className="font-mono">{c.busted}</span>,
    },
    {
      key: "stall",
      header: "Stalled",
      align: "right",
      cell: (c) => <span className="font-mono">{c.stalled}</span>,
    },
    {
      key: "mean",
      header: "Average change vs start",
      align: "right",
      cell: (c) =>
        c.meanReturnPpm === null ? (
          <NotMeasured />
        ) : (
          <GainLoss value={c.meanReturnPpm} kind="ppm" />
        ),
    },
  ];

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-6">
      <StrategyTabs current="leaderboard" />
      <header className="flex min-w-0 flex-col gap-2">
        <h1 className="m-0 text-2xl font-semibold">Leaderboard</h1>
        <p className="m-0 text-sm text-text-muted">
          How the strategies compare with each other and with their matched controls. Strategies
          whose ranges overlap are shown together as tied, not in order.
        </p>
        <SimulatedLabel />
        <div className="flex flex-wrap items-start gap-2">
          <RegimeBadge regime={mood} />
        </div>
        <Chips label="Filter by market mood" items={regimeChips} />
        <Chips label="Cost profile" items={costChips} />
        {cost ? (
          <p className="m-0 text-xs text-text-muted">
            Values re-costed overnight under cost profile {cost}, from stored rows.
          </p>
        ) : null}
        {regime ? (
          <p className="m-0 text-xs text-text-muted">
            The round counts show only rounds that started in a {regimeLabel(regime).shown} market.
            Chances and ranges cover all rounds.
          </p>
        ) : null}
      </header>

      {lb.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {lb.text}
        </Banner>
      ) : null}

      {rows.size === 0 ? (
        <EmptyState title="No strategies yet">{lb.text}</EmptyState>
      ) : (
        <>
          {lb.state === "empty" ? <Banner>{lb.text}</Banner> : null}

          <section aria-labelledby="ranked-h" className="flex min-w-0 flex-col gap-4">
            <h2 id="ranked-h" className="m-0 text-xl font-semibold">
              Ranked strategies{compared > 0 ? ` (${compared} compared)` : ""}
            </h2>
            {groups.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">
                <NotMeasured>No strategy has enough finished rounds to be ranked yet</NotMeasured>
              </p>
            ) : (
              groups.map((g, i) => (
                <section
                  key={g.members.map((m) => m.id).join("+")}
                  aria-labelledby={`group-${i}`}
                  data-tied={g.tied ? "true" : "false"}
                  className={`flex min-w-0 flex-col gap-2 rounded-lg ${g.tied ? "border border-dashed border-border p-3" : ""}`}
                >
                  <h3 id={`group-${i}`} className="m-0 text-base font-semibold">
                    {g.tied
                      ? `Tied group: ${g.members.length} strategies that cannot be told apart`
                      : `Group ${i + 1}: ${g.members[0]!.name}`}
                  </h3>
                  {g.tied ? (
                    <p className="m-0 text-sm text-text-muted">
                      Their 90% ranges overlap, so they are listed A to Z and not put in order.
                    </p>
                  ) : null}
                  <DataTable
                    caption={g.tied ? `Tied group ${i + 1}` : `Group ${i + 1}`}
                    columns={cols}
                    rows={g.members}
                    rowKey={(r) => r.id}
                  />
                </section>
              ))
            )}
          </section>

          <section aria-labelledby="insuf-h" className="flex min-w-0 flex-col gap-3">
            <h2 id="insuf-h" className="m-0 text-xl font-semibold">
              Not enough evidence yet
            </h2>
            <p className="m-0 text-sm text-text-muted">
              These need at least 3 separate finished rounds before they can be ranked.
            </p>
            <DataTable
              caption="Strategies without enough evidence"
              columns={cols}
              rows={insufficient}
              rowKey={(r) => r.id}
              empty={
                <p className="m-0 text-sm text-text-muted">Every strategy has enough evidence.</p>
              }
            />
          </section>

          <section aria-labelledby="ctl-h" className="flex min-w-0 flex-col gap-3">
            <h2 id="ctl-h" className="m-0 text-xl font-semibold">
              Controls
            </h2>
            <p className="m-0 text-sm text-text-muted">
              Matched controls C1, C2 and C3 follow simple rules with no edge. A strategy that beats
              them by luck is flagged &ldquo;possible luck&rdquo;.
            </p>
            <DataTable
              caption="Matched controls"
              columns={ctl}
              rows={lb.data.controls}
              rowKey={(c) => c.execution}
              empty={<p className="m-0 text-sm text-text-muted">No control rounds yet.</p>}
            />
          </section>
        </>
      )}
      <p className="m-0 text-xs text-text-muted">
        All figures are simulated and from past rounds. They are not a forecast.
      </p>
    </main>
  );
}
