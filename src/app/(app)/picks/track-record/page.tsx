// Track record (UXN-043, ARN-095). Immutable by design: this page reads the stored outcomes and the
// numbers published with each pick, and offers no way to edit, delete, re-run or re-score anything (no
// form, no button, no server action). A missed pick is shown as missed and is neither a win nor a loss.
// A masked user sees "Stock A", percentages and ISO weeks, never prices (DAT-124).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadTrackRecord, parsePicksQuery, type TrackRow } from "@/lib/ui/loaders/picks";
import { Breadcrumb } from "@/components/ui/Nav";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { Masked, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { ProfileSwitch } from "../PickTabs";
import { SuccessStrip } from "../SuccessStrip";
import { pickProfilesConfig } from "../data";
import {
  exitWords,
  NOT_REAL_ORDERS,
  pct,
  POSITION_WORDS,
  profileRules,
  profileSentence,
  trackStateText,
} from "../text";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

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

function result(r: TrackRow) {
  if (r.state === "missed") return <span>Missed — price ran away (not a win or a loss)</span>;
  if (r.state === "closed") {
    return (
      <span>
        {pct(r.netPpm)} after costs
        {r.exitReason ? `; ${exitWords(r.exitReason)}` : ""}
        {r.position ? `; ${POSITION_WORDS[r.position]}` : ""}
      </span>
    );
  }
  return <span>{trackStateText(r)}</span>;
}

export default async function TrackRecordPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/picks/track-record");
  const env = await envFor(user);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const query = await parsePicksQuery(env, q);
  if (query === null) notFound();
  const model = await loadTrackRecord(env, { profile: query.profile });
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
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <Breadcrumb
        backHref="/picks"
        items={[{ label: "Picks", href: "/picks" }, { label: "Track record" }]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Track record</h1>
        <p className="m-0 text-sm text-text-muted">
          Every pick as published, next to what happened. Price only — dividends not included.
          Nothing shown here can be changed afterwards. {NOT_REAL_ORDERS}
        </p>
      </header>

      <ProfileSwitch
        profiles={model.profiles}
        current={model.profile}
        base="/picks/track-record"
        rule={rule}
      />

      {model.success ? (
        <SuccessStrip success={model.success} profile={model.profile} linkToRecord={false} />
      ) : null}

      {!model.masked && model.rows.length > 0 ? <SimulatedLabel /> : null}

      <DataTable
        caption="Track record of published picks"
        columns={columns}
        rows={model.rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState title="No tracked picks yet">
            Picks appear here after they are published and followed on paper.
          </EmptyState>
        }
      />

      <p className="m-0 text-sm">
        <Link
          href={`/picks?profile=${encodeURIComponent(model.profile)}`}
          className="text-accent underline"
        >
          Back to Picks
        </Link>
      </p>
    </main>
  );
}
