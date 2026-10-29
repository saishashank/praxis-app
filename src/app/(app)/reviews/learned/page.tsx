// What the system learned = Knowledge (UX-070/071/071a, KB-070, UXN-200/201/208; M7 T18). Search and
// filter the knowledge documents, then: families, lessons as cards, challengers (with the Owner's
// compare selector), hypotheses with notes, the change ledger and the learning plan. Read-only for
// every role; a masked user (Editor/Viewer without a grant) gets rules-only content (DAT-124), decided
// in the loaders. Owner actions live on the family, lesson and challenger pages (D-125 routes).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { envFor } from "@/lib/ui/loaders/shell";
import { DOC_TYPES } from "@/lib/learning/readers";
import { loadKnowledge, parseKnowledgeQuery } from "@/lib/ui/loaders/knowledge";
import {
  dayText,
  documentHref,
  FAMILIES,
  loadFamilySummaries,
  loadHypotheses,
  loadLedger,
  loadLessonCards,
} from "@/lib/ui/loaders/knowledgeViews";
import { familyBadge } from "../../home/familyMap";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { Banner, EmptyState, ShowDetails } from "@/components/ui/States";
import { Notes } from "./Notes";
import {
  ChallengerLine,
  familyHref,
  GRADE_HELP,
  LessonCard,
  LEARNED,
  PageHead,
  Shell,
} from "./parts";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const GRADE_CHOICES = ["L0", "L1", "L2", "L3", "retired"] as const;
const FIELD = "min-h-6 w-full rounded-md border border-border bg-bg p-2 text-text";

export default async function LearnedPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", LEARNED);
  const env = await envFor(user);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const query = parseKnowledgeQuery(q);
  if (query === null) notFound();

  const [model, families, lessons, ledger, hypotheses] = await Promise.all([
    loadKnowledge(env, query),
    loadFamilySummaries(env),
    loadLessonCards(env, { grade: query.grade, family: query.family, q: query.q }),
    loadLedger(env),
    loadHypotheses(env),
  ]);
  const needle = query.q?.toLowerCase();
  const challengers = model.challengers
    .filter((c) => needle === undefined || c.id.toLowerCase().includes(needle))
    .map((c) => ({ ...c, stateDay: dayText(c.stateD, model.masked) }));
  const isOwner = user.role === "owner";
  const canWrite = can(user.role, "annotate");
  const filtered = query.q !== undefined || query.type || query.family || query.grade;
  const empty =
    model.state === "empty" && lessons.length === 0 && hypotheses.length === 0 && !filtered;

  return (
    <Shell>
      <PageHead title="What the system learned">
        Lessons, strategy families and rule changes, with the evidence behind each. A lesson is
        never described as stronger than its grade.
      </PageHead>
      {model.masked ? (
        <Banner tone="info">
          Your access shows the rules only: no stock names or codes, and dates are shown as weeks.
        </Banner>
      ) : null}

      <Card title="Search">
        <form method="get" action={LEARNED} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <label className="flex min-w-0 flex-col gap-1 text-sm sm:col-span-4">
            <span className="font-medium">Search the knowledge</span>
            <input
              type="search"
              name="q"
              maxLength={60}
              defaultValue={query.q ?? ""}
              className={FIELD}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">Kind of document</span>
            <select name="type" defaultValue={query.type ?? ""} className={FIELD}>
              <option value="">All</option>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">Strategy family</span>
            <select name="family" defaultValue={query.family ?? ""} className={FIELD}>
              <option value="">All</option>
              {FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {familyBadge(f).label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">Evidence grade</span>
            <select name="grade" defaultValue={query.grade ?? ""} className={FIELD}>
              <option value="">All</option>
              {GRADE_CHOICES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit">Search</Button>
            {filtered ? (
              <Link
                href={LEARNED}
                className="inline-flex min-h-6 items-center text-accent underline"
              >
                Clear
              </Link>
            ) : null}
          </div>
        </form>
        <p className="m-0 mt-2 text-xs text-text-muted">{GRADE_HELP}</p>
      </Card>

      {empty ? (
        <EmptyState motif="reviews" hue="reviews" title="Nothing learned yet">
          Lessons and rule changes appear here after the weekly learning run finds a pattern that
          holds up. Until then the strategies keep their starting rules.
        </EmptyState>
      ) : (
        <>
          <Card title="Strategy families">
            <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
              {families.map((f) => (
                <li
                  key={f.family}
                  data-testid="family-card"
                  className="min-w-0 rounded-lg border border-border bg-bg p-3 text-sm break-words"
                >
                  <Link href={familyHref(f.family)} className="font-semibold text-accent underline">
                    Family {f.family}
                  </Link>
                  <p className="m-0 mt-1">
                    {f.liveId === null ? "No live version yet" : `Live version ${f.liveId}`}
                  </p>
                  <p className="m-0 text-text-muted">
                    {f.versions} versions, {f.lessons} lessons, {f.challengers} challengers
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Lessons">
            {lessons.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">
                {filtered ? "No lesson matches this search." : "No lessons yet."}
              </p>
            ) : (
              <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {lessons.map((l) => (
                  <li key={l.id} className="min-w-0">
                    <LessonCard lesson={l} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Challengers">
            {challengers.length === 0 ? (
              <EmptyState compact motif="reviews" hue="reviews" title="No challengers yet." />
            ) : isOwner ? (
              <form
                method="get"
                action={`${LEARNED}/compare`}
                aria-label="Compare challengers"
                className="flex flex-col gap-3"
              >
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {challengers.map((c) => (
                    <ChallengerLine key={c.id} c={c} select />
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit">Compare selected</Button>
                  <span className="text-xs text-text-muted">Pick 2 to 5 challengers.</span>
                </div>
              </form>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {challengers.map((c) => (
                  <ChallengerLine key={c.id} c={c} />
                ))}
              </ul>
            )}
          </Card>

          <Card title="Hypotheses">
            {hypotheses.length === 0 ? (
              <EmptyState compact motif="reviews" hue="reviews" title="No hypotheses yet." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {hypotheses.map((h) => (
                  <li key={h.id} className="min-w-0 text-sm break-words">
                    <p className="m-0 font-medium">
                      {h.title} <span className="text-text-muted">({h.day})</span>
                    </p>
                    <ShowDetails summary="Show the hypothesis and notes">
                      <p className="m-0 mb-2 whitespace-pre-wrap">{h.body}</p>
                      <Notes kind="hypothesis" id={h.id} notes={h.notes} canWrite={canWrite} />
                    </ShowDetails>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Change ledger">
            <DataTable
              caption="Changes the system made to its own rules"
              rows={ledger}
              rowKey={(r) => String(r.id)}
              empty={<EmptyState compact motif="reviews" hue="reviews" title="No changes yet." />}
              columns={[
                { key: "day", header: "When", cell: (r) => r.day },
                { key: "kind", header: "What", cell: (r) => r.kind },
                { key: "target", header: "Where", cell: (r) => r.target },
                ...(model.masked
                  ? []
                  : [
                      { key: "actor", header: "By", cell: (r: (typeof ledger)[number]) => r.actor },
                      {
                        key: "summary",
                        header: "Change",
                        cell: (r: (typeof ledger)[number]) => r.summary ?? "n/a",
                      },
                    ]),
              ]}
            />
          </Card>

          <Card title="Learning plan">
            {model.plan === null ? (
              <EmptyState
                compact
                motif="reviews"
                hue="reviews"
                title="No plan has been written yet."
              />
            ) : (
              <div className="flex flex-col gap-3 text-sm">
                <p className="m-0 text-text-muted">Plan of {dayText(model.plan.d, model.masked)}</p>
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {model.plan.items.map((i) => (
                    <li key={i.rank} className="min-w-0 break-words">
                      <span className="font-medium">
                        {i.rank}. {i.kind.replace(/_/g, " ")}
                      </span>
                      : {i.reason.replace(/^no-lesson:/, "")}{" "}
                      <span className="text-text-muted">(lane {i.lane})</span>
                    </li>
                  ))}
                </ol>
                {model.plan.reviews.length > 0 ? (
                  <ShowDetails summary="How the last plan turned out">
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {model.plan.reviews.map((r) => (
                        <li key={r.rank}>
                          {r.rank}. {r.outcome} ({dayText(r.reviewed_d, model.masked)})
                        </li>
                      ))}
                    </ul>
                  </ShowDetails>
                ) : null}
              </div>
            )}
          </Card>

          <Card title="Documents">
            {model.documents.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">
                {filtered ? "No document matches this search." : "No documents yet."}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {model.documents.map((d) => {
                  const title = (d.front as { title?: unknown } | null)?.title;
                  const href = model.masked ? null : documentHref(d.path);
                  const label = typeof title === "string" && title !== "" ? title : "Untitled";
                  return (
                    <li key={`${d.path}@${d.version}`} className="min-w-0 break-words">
                      {href ? (
                        <Link href={href} className="text-accent underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}{" "}
                      <span className="text-text-muted">
                        ({d.doc_type.replace(/_/g, " ")}, version {d.version},{" "}
                        {dayText(d.d, model.masked)})
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </Shell>
  );
}
