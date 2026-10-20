// Server components shared by the "What the system learned" pages (M7 T18). No state; links and text.
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { GradeBadge } from "@/components/ui/Badges";
import { Term } from "@/components/ui/Overlays";
import { NotMeasured } from "@/components/ui/Values";
import type {
  ChallengerCard,
  CritiqueView,
  LessonCard as LessonCardData,
} from "@/lib/ui/loaders/knowledgeViews";

export const LEARNED = "/reviews/learned";
export const lessonHref = (id: string): string => `${LEARNED}/lessons/${encodeURIComponent(id)}`;
export const challengerHref = (id: string): string =>
  `${LEARNED}/challengers/${encodeURIComponent(id)}`;
export const familyHref = (f: string): string => `${LEARNED}/families/${encodeURIComponent(f)}`;

export const GRADE_HELP =
  "Grades say how much evidence stands behind a lesson. L0 is an observation, L1 held up in the first two-thirds of the history, L2 held up in the last third kept aside, L3 is adopted.";

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children ? <p className="m-0 text-sm text-text-muted">{children}</p> : null}
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      {children}
    </main>
  );
}

/** UXN-200: headline, evidence-grade badge, metric, n. No wording stronger than the grade. */
export function LessonCard({ lesson }: { lesson: LessonCardData }) {
  return (
    <article
      data-testid="lesson-card"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4 break-words"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="m-0 min-w-0 text-base font-semibold">
          <Link href={lessonHref(lesson.id)} className="text-accent underline">
            {lesson.headline}
          </Link>
        </h3>
        <GradeBadge grade={lesson.grade === "retired" ? null : lesson.grade} />
      </div>
      <p className="m-0 text-sm">{lesson.gradeText}</p>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-text-muted">Measured by</dt>
        <dd className="m-0 min-w-0">{lesson.metric}</dd>
        <dt className="text-text-muted">Cases (n)</dt>
        <dd className="m-0 font-mono">{lesson.n === null ? <NotMeasured /> : lesson.n}</dd>
        <dt className="text-text-muted">Strategy family</dt>
        <dd className="m-0">
          <Link href={familyHref(lesson.family)} className="text-accent underline">
            {lesson.family}
          </Link>
        </dd>
      </dl>
      <p className="m-0 text-xs text-text-muted">Found {lesson.createdDay}</p>
    </article>
  );
}

export function StageText({ stage }: { stage: string }) {
  return <span className="font-mono">{stage}</span>;
}

export function ChallengerLine({
  c,
  select,
}: {
  c: ChallengerCard;
  /** Owner only: the checkbox of the comparison form. */
  select?: boolean;
}) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 break-words text-sm">
      {select ? (
        <label className="inline-flex min-h-6 items-center gap-1">
          <input type="checkbox" name="ids" value={c.id} />
          <span className="sr-only">Compare {c.id}</span>
        </label>
      ) : null}
      <Link href={challengerHref(c.id)} className="font-mono text-accent underline">
        {c.id}
      </Link>
      <span>
        {c.family}: <StageText stage={c.state} /> since {c.stateDay}
      </span>
      <span className="text-text-muted">
        {c.ready ? "All Critic checks passed" : "Not ready: a Critic check has not passed"}
      </span>
    </li>
  );
}

/** The six Critic checks, one line each (state in words). */
export function CritiqueBlock({ critique, masked }: { critique: CritiqueView; masked: boolean }) {
  if (critique === null) {
    return <p className="m-0 text-sm text-text-muted">No Critic result yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm">
        <Term meaning="The Critic is a set of fixed checks that every lesson and challenger must pass before it counts.">
          Critic
        </Term>{" "}
        result of {critique.day}: {critique.passed ? "all checks passed" : "not every check passed"}
        .
      </p>
      <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
        {critique.checks.map((c) => (
          <li key={c.n} className="min-w-0 break-words">
            <span className="font-medium">
              {c.n}. {c.name}
            </span>{" "}
            <span className="font-mono">{c.state}</span>
            {c.detail ? <span className="text-text-muted">: {c.detail}</span> : null}
          </li>
        ))}
      </ol>
      {critique.notes.map((n) => (
        <p key={n.kind} className="m-0 text-sm break-words">
          <span className="font-medium">{n.kind}:</span> {n.text}
        </p>
      ))}
      {masked ? (
        <p className="m-0 text-xs text-text-muted">
          Written notes of the Critic are hidden for your access.
        </p>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Card title={title} id={id}>
      {children}
    </Card>
  );
}
