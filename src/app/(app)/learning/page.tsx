// Learning overview, minimal (M6 T14, decision 35): challengers and lessons with links to their pages.
// All signed-in roles may read. Full screens are M7.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { listChallengers, listLessons } from "@/lib/learning/ownerActions";

export const dynamic = "force-dynamic";

export default async function LearningPage() {
  await requireUser("read", "/learning");
  const db = mainDb();
  const [challengers, lessons] = await Promise.all([listChallengers(db), listLessons(db)]);
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Learning</h1>
      <h2 className="mt-6 font-medium">Challengers</h2>
      {challengers.length === 0 ? <p className="text-sm">None yet.</p> : null}
      <ul className="mt-2 text-sm">
        {challengers.map((c) => (
          <li key={String(c.id)}>
            <Link href={`/learning/challengers/${encodeURIComponent(String(c.id))}`}>
              {String(c.id)}
            </Link>{" "}
            {String(c.family)}: {String(c.state)}
            {Number(c.ready) === 1 ? " (ready)" : ""}
          </li>
        ))}
      </ul>
      <h2 className="mt-6 font-medium">Lessons</h2>
      {lessons.length === 0 ? <p className="text-sm">None yet.</p> : null}
      <ul className="mt-2 text-sm">
        {lessons.map((l) => (
          <li key={String(l.id)}>
            <Link href={`/learning/lessons/${encodeURIComponent(String(l.id))}`}>
              {String(l.id)}
            </Link>{" "}
            {String(l.grade ?? "none")}
          </li>
        ))}
      </ul>
    </main>
  );
}
