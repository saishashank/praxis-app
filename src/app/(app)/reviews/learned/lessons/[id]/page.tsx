// One lesson (UX-070/071/071a, UXN-200; D-125): grade, grade history, Critic checks, notes, and the
// Owner's two buttons (force apply, retire). All signed-in roles read; only the Owner sees the buttons.
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadLesson, loadNotes } from "@/lib/ui/loaders/knowledgeViews";
import { GradeBadge } from "@/components/ui/Badges";
import { Card } from "@/components/ui/Card";
import { Notes } from "../../Notes";
import { OwnerActions, type OwnerButton } from "../../OwnerActions";
import { CritiqueBlock, familyHref, GRADE_HELP, LEARNED, PageHead, Shell } from "../../parts";

export const dynamic = "force-dynamic";

const MAX_ID = 200; // threshold-ok: id length guard

export default async function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (id.length === 0 || id.length > MAX_ID) notFound();
  const user = await requireUser("read", `${LEARNED}/lessons/${encodeURIComponent(id)}`);
  const env = await envFor(user);
  const lesson = await loadLesson(env, id);
  if (lesson === null) notFound();
  const notes = (await loadNotes(env, "lesson", [id])).get(id) ?? [];
  const base = `/api/learning/lessons/${encodeURIComponent(id)}`;
  const buttons: OwnerButton[] =
    user.role === "owner" && !lesson.retired
      ? [
          {
            label: "Force apply",
            path: `${base}/force-apply`,
            prompt: "Force-apply this lesson? It appears as Unproven notes, forced by Owner.",
          },
          {
            label: "Retire",
            path: `${base}/retire`,
            prompt: "Retire this lesson? This cannot be undone.",
            danger: true,
          },
        ]
      : [];

  return (
    <Shell>
      <PageHead title={lesson.headline}>
        Lesson {lesson.id}, found {lesson.createdDay}, measured by {lesson.metric}. Rule version{" "}
        {lesson.ruleVersion} of{" "}
        <Link href={familyHref(lesson.family)} className="text-accent underline">
          family {lesson.family}
        </Link>
        .
      </PageHead>
      <Card title="Evidence grade">
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
          <GradeBadge grade={lesson.retired ? null : lesson.grade} />
          <span>{lesson.gradeText}</span>
        </p>
        <p className="m-0 mt-2 text-xs text-text-muted">{GRADE_HELP}</p>
        <h3 className="mt-4 mb-1 text-sm font-semibold">Grade history</h3>
        {lesson.history.length === 0 ? (
          <EmptyState
            compact
            motif="reviews"
            hue="reviews"
            title="No grade has been recorded yet."
          />
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {lesson.history.map((g) => (
              <li key={g.seq} className="min-w-0 break-words">
                {g.day}: <span className="font-mono">{g.grade}</span> from {g.n} cases
                {g.text ? ` — ${g.text}` : ""}
              </li>
            ))}
          </ol>
        )}
        {buttons.length > 0 ? <OwnerActions buttons={buttons} label="Owner actions" /> : null}
      </Card>
      <Card title="Critic checks">
        <CritiqueBlock critique={lesson.critique} masked={lesson.masked} />
      </Card>
      <Card title="Notes">
        <Notes kind="lesson" id={id} notes={notes} canWrite={can(user.role, "annotate")} />
        {lesson.masked ? (
          <p className="m-0 mt-2 text-xs text-text-muted">
            Your access hides stock names, so a note may show only that it was added.
          </p>
        ) : null}
      </Card>
    </Shell>
  );
}
