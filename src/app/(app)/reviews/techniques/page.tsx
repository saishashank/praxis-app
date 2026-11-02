// Techniques (M13-lite WP6; UXN-294, KB-075, KB-076, KB-079, D-515, D-532, D-533, D-599). One card per group
// of expert claims: the statement, who says it and who disagrees, outside evidence, whether it can be
// tested with Praxis today, the latest screening result (descriptive, percentages only, development split
// only) or the plain reason there is none, and the challenger link when one exists. The gap report lists
// the inputs experts rely on that Praxis does not have; adding one is a build change the Owner approves.
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadTechniques, parseTechniqueQuery, type TechniqueRow } from "@/lib/ui/loaders/experts";
import { PageHead, Shell } from "../learned/parts";
import { challengerLink, detailHref, Out, pct, TECHNIQUES } from "../experts/parts";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const FIELD = "min-h-6 w-full rounded-md border border-border bg-bg p-2 text-text";

const STATE_WORD: Record<string, string> = {
  proposed: "waiting for a person to confirm",
  confirmed: "confirmed",
  parked: "parked",
  merged: "merged",
};
const GRADE_WORD: Record<string, string> = {
  supports: "outside studies support it",
  mixed: "outside studies are mixed",
  contradicts: "outside studies contradict it",
  none: "no outside study found",
  not_searched: "outside studies not searched yet",
};
const TEST_WORD: Record<string, string> = {
  testable_eod: "can be tested on end-of-day data",
  needs_new_data: "needs data Praxis does not collect yet",
  needs_intraday: "needs intraday data",
  not_testable: "cannot be tested",
};
const label = (s: string): string => s.replace(/_/g, " ");

function ExpertList({ people }: { people: { id: string; name: string }[] }) {
  if (people.length === 0) return <span className="text-text-muted">none</span>;
  return (
    <>
      {people.map((p, i) => (
        <span key={p.id}>
          {i > 0 ? ", " : ""}
          <Link href={detailHref(p.id)} className="text-accent underline">
            {p.name}
          </Link>
        </span>
      ))}
    </>
  );
}

function Result({ t, caption }: { t: TechniqueRow; caption: string }) {
  const r = t.result;
  if (r === null) return <p className="m-0 text-sm">{t.screeningNote}</p>;
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-sm"
      data-technique-result={r.survived ? "passed" : "not_passed"}
    >
      <p className="m-0">
        {r.survived ? "Passed the screen" : "Did not pass the screen"} (family {r.family}, run{" "}
        {r.runDay ?? "date hidden"}, grade {r.grade}
        {r.rank !== null ? `, rank ${r.rank}` : ""}).{" "}
        {t.screeningNote !== "screened this week" ? t.screeningNote + "." : ""}
      </p>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        <dt className="text-text-muted">Controlled rows</dt>
        <dd className="m-0 font-mono">{r.controlledRows}</dd>
        <dt className="text-text-muted">Independent blocks</dt>
        <dd className="m-0 font-mono">{r.blocks}</dd>
        <dt className="text-text-muted">Mean net return per trade</dt>
        <dd className="m-0 font-mono">{pct(r.meanNetPct)}</dd>
        <dt className="text-text-muted">Mean excess over matched controls</dt>
        <dd className="m-0 font-mono">{pct(r.meanExcessPct)}</dd>
        <dt className="text-text-muted">Lower 90% bound of that excess</dt>
        <dd className="m-0 font-mono">{pct(r.lower90Pct)}</dd>
        <dt className="text-text-muted">p-value (adjusted)</dt>
        <dd className="m-0 font-mono">
          {r.p.toFixed(3)} ({r.adjustedP.toFixed(3)})
        </dd>
      </dl>
      <p className="m-0 text-xs text-text-muted">{caption}</p>
    </div>
  );
}

function Technique({ t, caption }: { t: TechniqueRow; caption: string }) {
  return (
    <article
      id={t.id}
      data-technique={t.id}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4 break-words"
    >
      <h3 className="m-0 text-base font-semibold">
        {t.id} {t.name}
      </h3>
      <p className="m-0 text-xs text-text-muted">
        {label(t.category)}; {STATE_WORD[t.state] ?? t.state};{" "}
        {TEST_WORD[t.testability] ?? t.testability}
      </p>
      <p className="m-0 text-sm">{t.statement}</p>
      {t.canonicalText ? (
        <p className="m-0 text-sm text-text-muted">Written as a rule: {t.canonicalText}</p>
      ) : null}
      <p className="m-0 text-sm">
        <span className="font-medium">Say it works:</span> <ExpertList people={t.expertsFor} />
        {t.expertsFor.length > 0 ? ` (${t.expertsFor.length})` : ""}
      </p>
      <p className="m-0 text-sm">
        <span className="font-medium">Disagree:</span> <ExpertList people={t.expertsAgainst} />
        {t.expertsAgainst.length > 0 ? ` (${t.expertsAgainst.length})` : ""}
      </p>
      <p className="m-0 text-sm">
        <span className="font-medium">Outside evidence:</span>{" "}
        {GRADE_WORD[t.externalGrade] ?? t.externalGrade}
        {t.evidenceLinks.length > 0 ? ": " : "."}
        {t.evidenceLinks.map((l, i) => (
          <span key={i}>
            {i > 0 ? ", " : ""}
            <Out link={l} label={l.note || null} />
          </span>
        ))}
      </p>
      {t.parkText !== null ? (
        <p className="m-0 text-sm" data-parked="">
          <span className="font-medium">Not screened:</span> {t.parkText}.
        </p>
      ) : null}
      <Result t={t} caption={caption} />
      {t.proposal ? (
        <p className="m-0 text-sm">
          <span className="font-medium">Challenger:</span> {t.proposal.statusText}
          {t.proposal.challengerId ? (
            <>
              {" "}
              (
              <Link
                href={challengerLink(t.proposal.challengerId)}
                className="text-accent underline"
              >
                open the challenger
              </Link>
              )
            </>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

export default async function TechniquesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", TECHNIQUES);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const query = parseTechniqueQuery(q);
  if (query === null) notFound();
  const m = await loadTechniques(
    { mainDb: mainDb(), authDb: authDb(), user: { id: user.id, role: user.role } },
    query,
  );

  return (
    <Shell>
      <PageHead title="Techniques">
        Methods that experts describe, grouped so the same idea is tested once. Each starts as an
        untested idea. Only a group a person has confirmed, that fits one of our strategy families,
        is screened, and only on the development part of the history.
      </PageHead>
      {m.masked ? (
        <Banner tone="info">
          Your access hides stock names and codes in the text below, shows dates as weeks, and hides
          links to outside pages (a web address can carry a code).
        </Banner>
      ) : null}
      <nav aria-label="Expert pages" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href="/reviews/experts" className="text-accent underline">
          Experts
        </Link>
        <Link href="/reviews/learned" className="text-accent underline">
          What the system learned
        </Link>
      </nav>
      {m.parkedForBuild > 0 ? (
        <Banner tone="info" title="Waiting for a build change">
          {m.parkedForBuild} confirmed {m.parkedForBuild === 1 ? "group needs" : "groups need"} a
          new strategy lineage (build change) before {m.parkedForBuild === 1 ? "it" : "they"} can be
          tested.
        </Banner>
      ) : null}

      <Card title="Filter">
        <form method="get" action={TECHNIQUES} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-sm sm:w-64">
            <span className="font-medium">Category</span>
            <select name="category" defaultValue={query.category ?? ""} className={FIELD}>
              <option value="">All</option>
              {m.categories.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">Filter</Button>
          {query.category ? (
            <Link
              href={TECHNIQUES}
              className="inline-flex min-h-6 items-center text-accent underline"
            >
              Clear
            </Link>
          ) : null}
        </form>
      </Card>

      {m.empty ? (
        <EmptyState title="No techniques have been added yet.">
          They arrive with the expert seed import.
        </EmptyState>
      ) : m.rows.length === 0 ? (
        <EmptyState title="No technique in that category." />
      ) : (
        <div className="flex flex-col gap-3" data-techniques="">
          {m.rows.map((t) => (
            <Technique key={t.id} t={t} caption={m.caption} />
          ))}
        </div>
      )}

      <Card title="Inputs experts use that Praxis does not have">
        {m.gaps.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">
            <NotMeasured>No gaps recorded.</NotMeasured>
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm" data-gap-report="">
            {m.gaps.map((g) => (
              <li key={g.input}>
                {g.sentence}
                {g.clusters.length > 0 ? (
                  <span className="text-text-muted"> (groups {g.clusters.join(", ")})</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 mt-2 text-xs text-text-muted">
          Adding an input or an indicator is a build change the Owner approves.
        </p>
      </Card>
    </Shell>
  );
}
