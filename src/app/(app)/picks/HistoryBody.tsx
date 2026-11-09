// History tab of /picks (Owner 2026-11-10): every published pick as a row, so a trade can be checked
// against what the pick said. Paged by key (newest first, no OFFSET, D-903), filtered by status with a
// plain GET form (works without JavaScript), "Open" by default. The same stock picked again on another
// day is its own row with its own buy and sale. Read only. A masked viewer sees the letter, the ISO
// week and percentages, never prices or dates (DAT-124), and only the first page.
import Link from "next/link";
import {
  HISTORY_FILTERS,
  loadPickHistory,
  type HistoryFilter,
  type HistoryRow,
} from "@/lib/ui/loaders/picks";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { GainLoss, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDate, formatPpm } from "@/lib/view/format";
import { ProfileSwitch } from "./PickTabs";
import { pickProfilesConfig } from "./data";
import { PicksEmptyArt } from "./EmptyArt";
import { exitWords, profileRules, profileSentence } from "./text";

export const FILTER_LABEL: Record<HistoryFilter, string> = {
  open: "Open",
  closed: "Closed",
  not_traded: "Not traded",
  waiting: "Waiting to buy",
  all: "All",
};

const STATUS_WORDS: Record<HistoryRow["status"], string> = {
  open: "Open",
  closed: "Closed",
  not_traded: "Not traded (buy price not reached)",
  waiting: "Waiting to buy",
};

const EMPTY_WORDS: Record<HistoryFilter, string> = {
  open: "No pick is open right now. Picks become open once the price reaches the buy price.",
  closed: "No pick has closed yet.",
  not_traded: "No pick has expired without reaching its buy price.",
  waiting: "No pick is waiting to be bought.",
  all: "No pick has been published yet.",
};

const change = (ppm: number | null) =>
  ppm === null ? null : formatPpm(ppm, { digits: 1, sign: "always" });

function priceOn(m: HistoryRow["entry"], d: string | null) {
  if (!m) return <NotMeasured>—</NotMeasured>;
  return (
    <span className="block">
      <Money micro={m.micro} />
      {d ? <span className="block text-xs text-text-muted">{formatDate(d)}</span> : null}
    </span>
  );
}

function statusCell(r: HistoryRow) {
  const why = r.status === "closed" ? exitWords(r.exitReason) : null;
  return (
    <span className="block" data-status={r.status}>
      {STATUS_WORDS[r.status]}
      {why ? <span className="block text-xs text-text-muted">{why}</span> : null}
    </span>
  );
}

function changeCell(r: HistoryRow) {
  const c = change(r.changePpm);
  if (c === null) return <NotMeasured>—</NotMeasured>;
  return (
    <span className="block">
      <GainLoss value={r.changePpm ?? 0}>{c}</GainLoss>
      {r.status === "closed" && r.netPpm !== null ? (
        <span className="block text-xs text-text-muted">{change(r.netPpm)} after costs</span>
      ) : r.status === "open" && r.now ? (
        <span className="block text-xs text-text-muted">
          now <Money micro={r.now.micro} />
        </span>
      ) : null}
    </span>
  );
}

function stockCell(r: HistoryRow) {
  return (
    <span className="block min-w-0 break-words">
      {r.stock}
      {r.plan ? (
        <span className="block text-xs text-text-muted">
          Plan: buy up to {r.plan.buyUpTo ? <Money micro={r.plan.buyUpTo.micro} /> : "—"}, stop{" "}
          {r.plan.stop ? <Money micro={r.plan.stop.micro} /> : "—"}, aim{" "}
          {r.plan.aim ? <Money micro={r.plan.aim.micro} /> : "—"}
        </span>
      ) : null}
    </span>
  );
}

export async function HistoryBody({
  env,
  profile,
  filter,
  cursor,
}: {
  env: LoaderEnv;
  profile: string;
  filter: HistoryFilter;
  cursor: string | null;
}) {
  const model = await loadPickHistory(env, { profile, filter, cursor });
  const rule = profileSentence(profileRules(await pickProfilesConfig(env.main), model.profile));
  const base = `/picks?profile=${encodeURIComponent(model.profile)}&view=history`;
  const withFilter = `${base}&status=${model.filter}`;
  const columns: Column<HistoryRow>[] = [
    { key: "stock", header: "Stock", cell: stockCell },
    {
      key: "picked",
      header: "Picked",
      cell: (r) => (model.masked ? r.pickedD : formatDate(r.pickedD)),
    },
    { key: "entry", header: "Bought at", cell: (r) => priceOn(r.entry, r.entryD) },
    { key: "exit", header: "Sold at", cell: (r) => priceOn(r.exit, r.exitD) },
    { key: "status", header: "Status", cell: statusCell },
    {
      key: "days",
      header: "Days held",
      cell: (r) => (r.daysHeld === null ? <NotMeasured>—</NotMeasured> : String(r.daysHeld)),
    },
    { key: "change", header: "Change", cell: changeCell },
  ];

  return (
    <>
      <ProfileSwitch
        profiles={model.profiles}
        current={model.profile}
        hrefFor={(p) => `/picks?profile=${encodeURIComponent(p)}&view=history`}
        rule={rule}
      />

      <form method="get" action="/picks" className="flex flex-wrap items-center gap-2 text-sm">
        <input type="hidden" name="profile" value={model.profile} />
        <input type="hidden" name="view" value="history" />
        <label htmlFor="history-status" className="font-medium">
          Show
        </label>
        <select
          id="history-status"
          name="status"
          defaultValue={model.filter}
          className="rounded-md border border-border bg-surface px-2 py-1"
        >
          {HISTORY_FILTERS.map((f) => (
            <option key={f} value={f}>
              {FILTER_LABEL[f]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-border bg-surface px-3 py-1 font-medium"
        >
          Apply
        </button>
      </form>

      <p className="m-0 text-xs text-text-muted">
        Change is the price move from the buy: to the sale once closed, to the latest price while
        open (delayed quote during the session, else the last close). Days held are calendar days.
      </p>

      {!model.masked && model.rows.length > 0 ? <SimulatedLabel /> : null}

      <DataTable
        caption="History of published picks"
        columns={columns}
        rows={model.rows}
        rowKey={(r) => r.id}
        empty={<PicksEmptyArt title="Nothing here yet">{EMPTY_WORDS[model.filter]}</PicksEmptyArt>}
      />

      {model.paged || model.next ? (
        <nav aria-label="History pages" className="flex gap-4 text-sm">
          {model.paged ? <Link href={withFilter}>Newest</Link> : null}
          {model.next ? (
            <Link href={`${withFilter}&after=${encodeURIComponent(model.next)}`}>Older</Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
