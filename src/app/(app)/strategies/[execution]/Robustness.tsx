// "Robustness" section of one strategy (M14 WP8, D-251; docs/M14_design.md 2.8). Server component:
// plain tables from the already masked model of loaders/robustness.ts. Descriptive only, never a
// finding. Every missing figure says "Not measured yet" (never 0 or blank); the whole section says it
// when nothing is stored. The page shows it to the Owner and the Editor only.
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import type { NeighbourView, RankQualityRow, RobustnessView } from "@/lib/ui/loaders/robustness";
import { formatCount, formatPercent } from "@/lib/view/format";

const PERCENT = 100; // threshold-ok: fraction to percent
const DIGITS_IC = 3; // threshold-ok: display precision of a rank correlation

/** A net return given as a fraction (0.012) -> "+1.20%"; null -> Not measured yet. */
function Net({ v }: { v: number | null }) {
  return v === null ? (
    <NotMeasured />
  ) : (
    <span className="font-mono">{formatPercent(v * PERCENT, { sign: "always" })}</span>
  );
}
function Rate({ v }: { v: number | null }) {
  return v === null ? (
    <NotMeasured />
  ) : (
    <span className="font-mono">{formatPercent(v * PERCENT, { digits: 1 })}</span>
  );
}
function Plain({ v, digits = 1 }: { v: number | null; digits?: number }) {
  return v === null ? <NotMeasured /> : <span className="font-mono">{v.toFixed(digits)}</span>;
}
const ic = (v: number | null) =>
  v === null ? <NotMeasured /> : <Plain v={v} digits={DIGITS_IC} />;

type Line = {
  key: string;
  label: string;
  n: number;
  mean: number | null;
  median: number | null;
  hit: number | null;
  held: number | null;
};

const lineCols: Column<Line>[] = [
  { key: "label", header: "Case", cell: (r) => r.label },
  { key: "n", header: "Trades", align: "right", cell: (r) => formatCount(r.n) },
  { key: "mean", header: "Average after costs", align: "right", cell: (r) => <Net v={r.mean} /> },
  { key: "median", header: "Middle trade", align: "right", cell: (r) => <Net v={r.median} /> },
  { key: "hit", header: "Share that gained", align: "right", cell: (r) => <Rate v={r.hit} /> },
  {
    key: "held",
    header: "Sessions held",
    align: "right",
    cell: (r) => <Plain v={r.held} />,
  },
];

const line = (
  key: string,
  label: string,
  s: {
    n: number;
    mean_net: number | null;
    median_net: number | null;
    hit_rate: number | null;
    mean_sessions_held: number | null;
  },
): Line => ({
  key,
  label,
  n: s.n,
  mean: s.mean_net,
  median: s.median_net,
  hit: s.hit_rate,
  held: s.mean_sessions_held,
});

const neighbourCols: Column<NeighbourView>[] = [
  {
    key: "setting",
    header: "Setting",
    cell: (r) => <span className="break-words">{r.setting}</span>,
  },
  {
    key: "step",
    header: "One step",
    cell: (r) => `${r.direction === "down" ? "Lower" : "Higher"}: ${r.value}`,
  },
  { key: "n", header: "Trades", align: "right", cell: (r) => formatCount(r.n) },
  {
    key: "mean",
    header: "Average after costs",
    align: "right",
    cell: (r) => <Net v={r.meanNet} />,
  },
  {
    key: "lower",
    header: "Cautious estimate",
    align: "right",
    cell: (r) => <Net v={r.netLower90} />,
  },
  { key: "gate", header: "Still passes", cell: (r) => (r.passes ? "Yes" : "No") },
];

const rankCols: Column<RankQualityRow>[] = [
  {
    key: "ranking",
    header: "Ranking",
    cell: (r) => <span className="break-words">{r.ranking}</span>,
  },
  { key: "days", header: "Days", align: "right", cell: (r) => formatCount(r.nDays) },
  { key: "median", header: "Middle rank match", align: "right", cell: (r) => ic(r.medianIc) },
  {
    key: "range",
    header: "90% range",
    align: "right",
    cell: (r) =>
      r.lower90 === null || r.upper90 === null ? (
        <NotMeasured />
      ) : (
        <span className="font-mono">
          {r.lower90.toFixed(DIGITS_IC)} to {r.upper90.toFixed(DIGITS_IC)}
        </span>
      ),
  },
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const nothing = (text?: string) => (
  <p className="m-0 text-sm">
    <NotMeasured>{text}</NotMeasured>
  </p>
);

export function Robustness({ view }: { view: RobustnessView }) {
  if (!view.visible) return null;
  const ab = view.exitAblation;
  const sl = view.slip;
  const st = view.stability;
  return (
    <Card title="Robustness" headingLevel={2} data-robustness="" aria-label="Robustness">
      <div className="flex min-w-0 flex-col gap-4">
        <p className="m-0 text-sm text-text-muted" data-robustness-label="">
          {view.label}. These checks describe how the rule behaves when it is changed a little. They
          do not decide anything and never change a rule by themselves. Simulated.
        </p>
        {!view.measured ? (
          <EmptyState compact motif="strategies" hue="strategies" title="Not measured yet">
            The weekly learning run has not stored these checks for this strategy.
          </EmptyState>
        ) : (
          <>
            <Block title="Does the exit rule help? Rule against time-stop only">
              {ab ? (
                <DataTable
                  caption="Exit rule against holding for the time limit only"
                  columns={lineCols}
                  rows={[
                    line("rule", "With its exit rules", ab.rule),
                    line("tso", "Time limit only", ab.timeStopOnly),
                  ]}
                  rowKey={(r) => r.key}
                />
              ) : (
                nothing()
              )}
            </Block>

            <Block title="One more tick of slippage on each side">
              {sl ? (
                <>
                  <DataTable
                    caption="Results with one more adverse price step per side"
                    columns={lineCols}
                    rows={[
                      line("base", "As simulated", sl.base),
                      line("tick", "One more tick each side", sl.oneTick),
                    ]}
                    rowKey={(r) => r.key}
                  />
                  <p className="m-0 text-sm">
                    Stress figure (more costly trading, 50% more slippage):{" "}
                    <Net v={sl.stressMeanNet} />
                  </p>
                </>
              ) : (
                nothing()
              )}
            </Block>

            <Block title="Stability: nudging each setting one step">
              {st ? (
                <>
                  <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      {st.passesAbsoluteGate
                        ? "The version in use passes the absolute test."
                        : "The version in use does not pass the absolute test."}
                    </span>
                    {st.fragile ? (
                      <span
                        data-fragile=""
                        className="rounded-full border border-border px-2 py-0.5 text-xs font-semibold"
                      >
                        Fragile: a small change breaks it
                      </span>
                    ) : null}
                  </p>
                  <DataTable
                    caption="Neighbouring settings, one step each way"
                    columns={neighbourCols}
                    rows={st.neighbours}
                    rowKey={(r) => `${r.setting}:${r.direction}`}
                    empty={nothing("No neighbours stored yet")}
                  />
                </>
              ) : (
                nothing()
              )}
            </Block>

            <Block title="Rank quality">
              {view.rankQuality.length > 0 ? (
                <DataTable
                  caption="How well each ranking orders the next day's winners"
                  columns={rankCols}
                  rows={view.rankQuality}
                  rowKey={(r) => r.ranking}
                />
              ) : (
                nothing()
              )}
              <p className="m-0 text-sm" data-min-btl="">
                {view.minBtl ? (
                  <>
                    Length of history: {view.minBtl.availableYears.toFixed(1)} years available;{" "}
                    {view.minBtl.minYears === null
                      ? "the minimum is not measured yet"
                      : `about ${view.minBtl.minYears.toFixed(1)} years are needed`}{" "}
                    after {formatCount(view.minBtl.trials)} variants tried:{" "}
                    <strong>{view.minBtl.label}</strong>.
                  </>
                ) : (
                  <>
                    Length of history needed: <NotMeasured />
                  </>
                )}
              </p>
              <p className="m-0 text-sm" data-error-budget="">
                {view.errorBudget ? (
                  <>
                    Error budget: the next test is run at a{" "}
                    {formatPercent(view.errorBudget.nextLevel * PERCENT, { digits: 2 })} level,
                    after {formatCount(view.errorBudget.testsSoFar)} tests so far. Lesson pool:{" "}
                    {view.errorBudget.lessonPool === "exhausted" ? "used up" : "open"}.
                  </>
                ) : (
                  <>
                    Error budget: <NotMeasured />
                  </>
                )}
              </p>
            </Block>
          </>
        )}
      </div>
    </Card>
  );
}
