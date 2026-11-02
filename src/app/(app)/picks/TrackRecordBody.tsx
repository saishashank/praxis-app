// Track record body (UXN-043, ARN-095), shared by the Track record tab of /picks (UXR-021) and the old
// route /picks/track-record (kept for links). Immutable by design: reads the stored outcomes and the
// numbers published with each pick, and offers no way to edit, delete, re-run or re-score anything (no
// form, no button, no server action). A missed pick is shown as missed and is neither a win nor a loss.
// A masked user sees "Stock A", percentages and ISO weeks, never prices (DAT-124).
import { loadTrackRecord, type TrackRow } from "@/lib/ui/loaders/picks";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Masked, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { ProfileSwitch } from "./PickTabs";
import { SuccessStrip } from "./SuccessStrip";
import { pickProfilesConfig } from "./data";
import { PicksEmptyArt } from "./EmptyArt";
import {
  EMPTY_TRACK_SENTENCE,
  exitWords,
  pct,
  POSITION_WORDS,
  profileRules,
  profileSentence,
  trackStateText,
  VS_MARKET_CAPTION,
  VS_MARKET_HELP,
  vsMarketRowText,
  vsMarketSummaryLine,
} from "./text";

function levels(r: TrackRow, masked: boolean) {
  const p = r.published;
  if (masked) return <Masked />;
  return (
    <span className="block">
      {p.buyUpTo ? <Money micro={p.buyUpTo.micro} /> : <NotMeasured />} /{" "}
      {p.stop ? <Money micro={p.stop.micro} /> : <NotMeasured />} /{" "}
      {p.aim ? <Money micro={p.aim.micro} /> : <NotMeasured />}
    </span>
  );
}

function VsMarket({ v }: { v: NonNullable<TrackRow["vsMarket"]> }) {
  return (
    <span className="block text-text-muted" data-testid="vs-market">
      {vsMarketRowText(v)} — {v.basisLabel}
    </span>
  );
}

function result(r: TrackRow) {
  if (r.state === "missed") {
    return (
      <span>
        {trackStateText(r)} (not a win or a loss)
        {r.vsMarket ? <VsMarket v={r.vsMarket} /> : null}
      </span>
    );
  }
  if (r.state === "closed") {
    return (
      <span>
        {pct(r.netPpm)} after costs
        {r.exitReason ? `; ${exitWords(r.exitReason)}` : ""}
        {r.position ? `; ${POSITION_WORDS[r.position]}` : ""}
        {r.vsMarket ? <VsMarket v={r.vsMarket} /> : null}
      </span>
    );
  }
  return <span>{trackStateText(r)}</span>;
}

export async function TrackRecordBody({
  env,
  profile,
  hrefFor,
}: {
  env: LoaderEnv;
  profile: string;
  hrefFor: (profile: string) => string;
}) {
  const model = await loadTrackRecord(env, { profile });
  const rule = profileSentence(profileRules(await pickProfilesConfig(env.main), model.profile));
  const columns: Column<TrackRow>[] = [
    { key: "when", header: "Published", cell: (r) => r.d },
    { key: "stock", header: "Stock", cell: (r) => r.stock },
    {
      key: "levels",
      header: "Buy up to / stop / aim (as published)",
      cell: (r) => levels(r, model.masked),
    },
    {
      key: "range",
      header: "Expected range (as published)",
      cell: (r) =>
        r.published.badPpm === null || r.published.goodPpm === null ? (
          <NotMeasured />
        ) : (
          `${pct(r.published.badPpm)} to ${pct(r.published.goodPpm)}`
        ),
    },
    { key: "result", header: "What happened", cell: (r) => result(r) },
  ];

  return (
    <>
      <ProfileSwitch
        profiles={model.profiles}
        current={model.profile}
        hrefFor={hrefFor}
        rule={rule}
      />

      {model.success ? (
        <SuccessStrip success={model.success} profile={model.profile} linkToRecord={false} />
      ) : null}

      {model.vsMarket ? (
        <section
          aria-label="Picks against the market"
          className="min-w-0 rounded-lg border border-border bg-surface p-3 text-sm"
        >
          <p className="m-0 font-semibold break-words" data-testid="vs-market-summary">
            {vsMarketSummaryLine(model.vsMarket)}
          </p>
          <p className="m-0 mt-1 text-text-muted">
            {model.vsMarket.basisLabel} {VS_MARKET_CAPTION}
          </p>
          <p className="m-0 mt-1 text-text-muted">{VS_MARKET_HELP}</p>
        </section>
      ) : null}

      {!model.masked && model.rows.length > 0 ? <SimulatedLabel /> : null}

      <DataTable
        caption="Track record of published picks"
        columns={columns}
        rows={model.rows}
        rowKey={(r) => r.id}
        empty={<PicksEmptyArt title="No tracked picks yet">{EMPTY_TRACK_SENTENCE}</PicksEmptyArt>}
      />
    </>
  );
}
