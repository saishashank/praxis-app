// Lesson page, minimal (M6 T14, decision 35, UX-071): grade history, Critic checks and the Owner's
// buttons with a confirmation. All signed-in roles may read; only the Owner sees the buttons.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { OwnerActions, type OwnerButton } from "../../OwnerActions";

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
  const user = await requireUser("read", `/learning/lessons/${encodeURIComponent(id)}`);
  const db = mainDb();
  const lesson = await db.execute({
    sql: "SELECT id, template_id, rule_version, created_d FROM lesson WHERE id = ?",
    args: [id],
  });
  if (lesson.rows.length === 0) notFound();
  const [grades, critique] = await Promise.all([
    db.execute({
      sql: "SELECT seq, grade, d, state_text FROM lesson_grade WHERE lesson_id = ? ORDER BY seq",
      args: [id],
    }),
    db.execute({
      sql: `SELECT checks_json, passed FROM critique WHERE subject_kind = 'lesson'
            AND subject_id = ? ORDER BY d DESC, run_id DESC LIMIT 1`,
      args: [id],
    }),
  ]);
  const current = grades.rows.at(-1);
  const base = `/api/learning/lessons/${encodeURIComponent(id)}`;
  const buttons: OwnerButton[] =
    user.role === "owner" && current !== undefined && String(current.grade) !== "retired"
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
          },
        ]
      : [];
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Lesson {id}</h1>
      <p className="mt-2 text-sm">
        Template {String(lesson.rows[0]!.template_id)}, rule version{" "}
        {String(lesson.rows[0]!.rule_version)}, created {String(lesson.rows[0]!.created_d)}. Grade:{" "}
        <strong>{current === undefined ? "none" : String(current.grade)}</strong>.
      </p>
      <h2 className="mt-6 font-medium">Grade history</h2>
      <ul className="mt-2 text-sm">
        {grades.rows.map((g) => (
          <li key={Number(g.seq)}>
            {String(g.d)}: {String(g.grade)} {String(g.state_text)}
          </li>
        ))}
      </ul>
      <h2 className="mt-6 font-medium">Critic checks</h2>
      {critique.rows[0] ? (
        <pre className="mt-2 overflow-x-auto text-xs">
          {JSON.stringify(JSON.parse(String(critique.rows[0].checks_json)), null, 2)}
        </pre>
      ) : (
        <p className="text-sm">No Critic result yet.</p>
      )}
      {buttons.length > 0 ? <OwnerActions buttons={buttons} /> : null}
    </main>
  );
}
