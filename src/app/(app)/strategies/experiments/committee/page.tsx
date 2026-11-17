// Committee trial (M22 C2; UXN-289, UXN-290, VAL-111; D-1420, D-1421, D-1423). The one place a Committee rating is shown.
// Signed-in roles read it; the Owner sees codes and exact dates, anyone else sees letters, week-only dates and no trial id
// (the loader masks, DAT-124). No button here changes the trial: it is read-only, and the Committee switch lives on the
// Configuration page. A rating is hidden on every card, pick and e-mail while the trial runs.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadCommitteeTrial } from "@/lib/ui/loaders/committee";
import { NOT_ADVICE_FOOTER } from "@/lib/view/honesty";

export const dynamic = "force-dynamic";

const PATH = "/strategies/experiments/committee";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function CommitteeTrialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("read", PATH);
  const sp = await searchParams;
  const before = one(sp.before);
  const page = await loadCommitteeTrial(
    { mainDb: mainDb(), authDb: authDb(), user },
    { before: before !== undefined && DATE_RE.test(before) ? before : null },
  );
  const v = page.data;

  return (
    <main className="mx-auto flex max-w-4xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <p className="m-0 text-sm">
          <Link href="/strategies" className="text-accent underline">
            Strategies
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Committee trial</h1>
        <p className="m-0 text-sm text-text-muted">
          A test of whether an AI panel&apos;s opinion of tonight&apos;s signals predicts how they
          turn out. The opinion is shown only here, never on a card, a pick or an e-mail, and it
          changes nothing about trading.
        </p>
        <p className="m-0 text-xs text-text-muted">{NOT_ADVICE_FOOTER}</p>
      </header>

      {page.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {page.text}
        </Banner>
      ) : null}

      {v.status === "none" ? (
        <EmptyState motif="strategies" hue="strategies" title={v.statusText}>
          The trial starts on the first night the Committee is on. Its settings are written down
          before the first opinion and cannot change.
        </EmptyState>
      ) : (
        <>
          <Card title="Where it stands" headingLevel={2} data-testid="committee-status">
            <p className="m-0 text-sm font-medium">{v.statusText}</p>
            {v.final !== null ? (
              <p className="m-0 mt-2 text-sm" data-testid="committee-final">
                Result on {v.final.dayText}: <strong>{v.final.verdictWord}</strong>. The Committee
                switched itself off.
              </p>
            ) : null}
            {v.progress !== null ? (
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm">
                <li data-testid="committee-nights">
                  Nights so far: {v.progress.nights}
                  {v.progress.trialSessions !== null ? ` of ${v.progress.trialSessions}` : ""}
                </li>
                <li data-testid="committee-settled">
                  Settled picks: {v.progress.settled}
                  {v.progress.minSettled !== null ? ` of ${v.progress.minSettled} needed` : ""}
                  {v.progress.unsettled > 0 ? `; ${v.progress.unsettled} still open` : ""}
                  {v.progress.late > 0 ? `; ${v.progress.late} settled too late to count` : ""}
                </li>
                {v.skippedNights > 0 ? (
                  <li>
                    {v.skippedNights} {v.skippedNights === 1 ? "night" : "nights"} with no opinion
                    at all (skipped).
                  </li>
                ) : null}
              </ul>
            ) : null}
          </Card>

          {v.figure !== null ? (
            <Card
              title={v.figure.interim ? "Latest figure" : "The figure behind the result"}
              headingLevel={2}
              data-testid="committee-figure"
            >
              {v.figure.note !== null ? (
                <p className="m-0 mb-2 text-sm font-semibold" data-testid="committee-interim-note">
                  {v.figure.note.charAt(0).toUpperCase() + v.figure.note.slice(1)}
                </p>
              ) : null}
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                <li>
                  Approved picks minus rejected picks, on average:{" "}
                  {v.figure.gap ?? "not measurable yet"}
                </li>
                <li>
                  Chance of a gap this large by luck: {v.figure.p ?? "not measurable yet"}
                  {v.figure.p !== null
                    ? v.figure.exact
                      ? " (every possible shuffle counted)"
                      : ` (${v.figure.permutations} shuffles within each night)`
                    : ""}
                </li>
                <li>Picks counted: {v.figure.counts}</li>
                {v.figure.costBar !== null ? (
                  <li>The gap must beat one round trip of costs: {v.figure.costBar}</li>
                ) : null}
                {v.figure.reason !== "" ? <li>{v.figure.reason}</li> : null}
              </ul>
              {v.figure.segments.length > 0 ? (
                <>
                  <h3 className="m-0 mt-3 text-sm font-semibold">By judge model</h3>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                    {v.figure.segments.map((s) => (
                      <li key={s.model}>
                        {s.model}: {s.n} settled; gap {s.gap ?? "not measurable"}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Card>
          ) : null}

          {v.prereg !== null ? (
            <Card
              title="Written down before it started"
              headingLevel={2}
              data-testid="committee-prereg"
            >
              <p className="m-0 mb-2 text-sm text-text-muted">
                Recorded on {v.prereg.createdText}
                {v.prereg.trialId !== null ? ` as ${v.prereg.trialId}` : ""}, version{" "}
                {v.prereg.version}.{" "}
                {v.prereg.versions > 1
                  ? "It was changed afterwards, so the trial is not valid."
                  : "It has not changed."}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {v.prereg.figures.map((f) => (
                  <li key={f.label}>
                    {f.label}: {f.value}
                  </li>
                ))}
                {v.prereg.statistic !== null ? (
                  <li>How it is judged: {v.prereg.statistic}</li>
                ) : null}
                <li className="break-all">Fingerprint: {v.prereg.sha}</li>
              </ul>
            </Card>
          ) : null}

          <section aria-labelledby="nights-h" className="flex flex-col gap-3">
            <h2 id="nights-h" className="m-0 text-xl font-semibold">
              Night by night
            </h2>
            {v.nights.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">No night has been rated yet.</p>
            ) : (
              v.nights.map((n) => (
                <Card key={n.dayText + String(n.d)} title={n.dayText} headingLevel={3}>
                  {n.allSkipped ? (
                    <p className="m-0 mb-2 text-sm text-text-muted">
                      Nothing was rated this night.
                    </p>
                  ) : null}
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {n.rows.map((r, i) => (
                      <li key={`${i}:${r.stock}`} className="min-w-0 break-words text-sm">
                        <p className="m-0 font-medium">
                          {r.stock}: {r.ratingWord}
                          {r.packHref !== null ? (
                            <>
                              {" "}
                              <Link href={r.packHref} className="text-accent underline">
                                Evidence it was given
                              </Link>
                            </>
                          ) : null}
                        </p>
                        {r.reasons.length > 0 ? (
                          <ul className="m-0 mt-1 list-disc pl-5">
                            {r.reasons.map((t, j) => (
                              <li key={j}>{t}</li>
                            ))}
                          </ul>
                        ) : null}
                        {r.statements.length > 0 ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-text-muted">The debate</summary>
                            {r.statements.map((s) => (
                              <div key={s.stage} className="mt-1">
                                <p className="m-0 font-semibold">{s.title}</p>
                                <ul className="m-0 list-disc pl-5">
                                  {s.points.map((t, j) => (
                                    <li key={j}>{t}</li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </details>
                        ) : null}
                        {!r.skipped ? (
                          <p className="m-0 mt-1 text-xs text-text-muted">
                            Models: for {r.models.bull ?? "none"}, against {r.models.bear ?? "none"}
                            , risks {r.models.risk ?? "none"}, judge {r.models.judge ?? "none"}
                            {r.sameFamily ? " (the same maker for and against)" : ""}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Card>
              ))
            )}
            {v.earlier !== null ? (
              <p className="m-0 text-sm">
                <Link href={`${PATH}?before=${v.earlier}`} className="text-accent underline">
                  Earlier nights
                </Link>
              </p>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}
