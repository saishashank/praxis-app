// The research half of the Cortex page (M23 M4; D-1643, D-1760...D-1769): four sections in plain words after "Opinion track":
// tests and their one look, waiting for data, risk monitors, sector series; the Owner alone also sees the proposal counts.
// Everything arrives already in words from `lib/research/pageView.ts` (lineages through lineageName, families through the
// family badge); nothing here shows a key, an internal code or a run time. Tables are DataTable (a real table from 600 px up,
// stacked cards below), so there is no sideways scroll to label.
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { NotMeasured } from "@/components/ui/Values";
import {
  INCONCLUSIVE_REASON,
  type MonitorRowView,
  type ResearchView,
  type SectorView,
  type TestRowView,
  type WaitRowView,
} from "@/lib/research/pageView";
import { formatCount } from "@/lib/view/format";

type SectorRow = SectorView["rows"][number];

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

const testCols: Column<TestRowView>[] = [
  { key: "name", header: "Test", cell: (r) => <span className="break-words">{r.name}</span> },
  { key: "market", header: "Market", cell: (r) => r.market },
  { key: "when", header: "Looked at", cell: (r) => r.when },
  { key: "result", header: "Result", cell: (r) => r.result },
  {
    key: "fp",
    header: "Plan fingerprint (first 12 characters)",
    cell: (r) => <span className="font-mono break-all">{r.fingerprint}</span>,
  },
  {
    key: "refused",
    header: "Repeat looks refused",
    align: "right",
    cell: (r) => formatCount(r.refusals),
  },
];

const waitCols: Column<WaitRowView>[] = [
  {
    key: "name",
    header: "Waiting for",
    cell: (r) => <span className="break-words">{r.name}</span>,
  },
  { key: "progress", header: "Collected so far", cell: (r) => r.progress },
  { key: "status", header: "State", cell: (r) => r.status },
  { key: "expected", header: "Expected", cell: (r) => r.expected ?? <NotMeasured /> },
];

const sectorCols: Column<SectorRow>[] = [
  {
    key: "group",
    header: "Industry group",
    cell: (r) => <span className="break-words">{r.group}</span>,
  },
  { key: "ret", header: "Return", align: "right", cell: (r) => r.returnText },
  { key: "n", header: "Companies", align: "right", cell: (r) => formatCount(r.members) },
];

function MonitorItem({ m }: { m: MonitorRowView }) {
  return (
    <li className="flex min-w-0 flex-col gap-1" data-research-monitor={m.monitor}>
      <h3 className="m-0 text-sm font-semibold break-words">
        {m.title}
        {m.period === null ? "" : ` (${m.period})`}
      </h3>
      {m.period === null ? (
        <p className="m-0 text-text-muted">
          <NotMeasured />
        </p>
      ) : (
        <ul className="m-0 list-none p-0 text-text-muted">
          {m.lines.map((l) => (
            <li key={l} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      )}
      {m.alarm ? (
        <ul className="m-0 list-none p-0" data-research-alarm="">
          {m.alarmLines.map((l) => (
            <li key={l} className="font-semibold break-words">
              Alarm: {l}.
            </li>
          ))}
        </ul>
      ) : m.period === null ? null : (
        <p className="m-0 text-text-muted">No alarm.</p>
      )}
    </li>
  );
}

/** Which of the four parts hold something (the page lists the rest under "Not measured yet"). */
export function researchHas(r: ResearchView) {
  return {
    tests: r.tests.length > 0,
    waiting: r.waiting.length > 0,
    monitors: r.monitors.some((m) => m.period !== null),
    sectorSeries: r.sector !== null,
  };
}

export function ResearchSections({ research }: { research: ResearchView }) {
  const has = researchHas(research);
  return (
    <>
      {has.tests ? (
        <Section id="research-tests" title="Tests and their one look">
          <p className="m-0 text-text-muted">
            Each idea gets one look at held-back data, with its plan written down first. A second
            look is refused and recorded.
          </p>
          <DataTable
            caption="Tests, their one look and the result"
            columns={testCols}
            rows={research.tests}
            rowKey={(r) => `${r.name}:${r.market}:${r.fingerprint}`}
          />
          {research.inconclusive.length > 0 ? (
            <div data-research-inconclusive="">
              <p className="m-0 font-semibold">Inconclusive</p>
              <ul className="m-0 list-none p-0 text-text-muted">
                {research.inconclusive.map((n) => (
                  <li key={n} className="break-words">
                    {n}: {INCONCLUSIVE_REASON}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}

      {research.proposals !== null && research.proposals.kept + research.proposals.refused > 0 ? (
        <Section id="research-proposals" title="Model-written proposals">
          <p className="m-0" data-owner-proposals="">
            {formatCount(research.proposals.kept)} kept for your review,{" "}
            {formatCount(research.proposals.refused)} refused. Nothing in the book changed.
          </p>
        </Section>
      ) : null}

      {has.waiting ? (
        <Section id="research-waiting" title="Waiting for data">
          <DataTable
            caption="Tests that are waiting for enough data"
            columns={waitCols}
            rows={research.waiting}
            rowKey={(r) => r.name}
          />
        </Section>
      ) : null}

      {has.monitors ? (
        <Section id="research-monitors" title="Risk monitors">
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {research.monitors.map((m) => (
              <MonitorItem key={m.monitor} m={m} />
            ))}
          </ul>
        </Section>
      ) : null}

      {research.sector !== null ? (
        <Section id="research-sector" title="Sector series">
          <p className="m-0 text-text-muted">
            Equal-weight return of each industry group, latest session: {research.sector.asOf}.
            {research.sector.label !== null
              ? ` Industry is ${research.sector.label}: past days use today's grouping.`
              : ""}
          </p>
          <DataTable
            caption="Industry groups and their latest equal-weight return"
            columns={sectorCols}
            rows={research.sector.rows}
            rowKey={(r) => r.group}
          />
        </Section>
      ) : null}
    </>
  );
}
