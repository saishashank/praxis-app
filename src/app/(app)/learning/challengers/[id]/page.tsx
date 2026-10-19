// Challenger page, minimal (M6 T14, decision 35, UX-071): state, event history, Critic checks and the
// Owner's buttons with a confirmation. All signed-in roles may read; only the Owner sees the buttons.
// Full screens are M7.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { loadChallenger } from "@/lib/learning/challengerLifecycle";
import { OwnerActions, ShadowResults, type OwnerButton } from "../../OwnerActions";

export const dynamic = "force-dynamic";

const MAX_ID = 200; // threshold-ok: id length guard

export default async function ChallengerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (id.length === 0 || id.length > MAX_ID) notFound();
  const user = await requireUser("read", `/learning/challengers/${encodeURIComponent(id)}`);
  const db = mainDb();
  const ch = await loadChallenger(db, id);
  if (ch === null) notFound();
  const [events, critique, notes] = await Promise.all([
    db.execute({
      sql: `SELECT seq, from_state, to_state, d, actor, reason FROM challenger_event
            WHERE challenger_id = ? ORDER BY seq`,
      args: [id],
    }),
    db.execute({
      sql: `SELECT checks_json, passed, d FROM critique WHERE subject_kind = 'challenger'
            AND subject_id = ? ORDER BY d DESC, run_id DESC LIMIT 1`,
      args: [id],
    }),
    db.execute({
      sql: `SELECT kind, text FROM critique_note WHERE subject_kind = 'challenger'
            AND subject_id = ? ORDER BY run_id DESC, kind`,
      args: [id],
    }),
  ]);
  const checks = critique.rows[0]
    ? (JSON.parse(String(critique.rows[0].checks_json)) as unknown)
    : null;
  const base = `/api/learning/challengers/${encodeURIComponent(id)}`;
  const isOwner = user.role === "owner";
  const buttons: OwnerButton[] = [];
  if (isOwner && ch.state === "review") {
    buttons.push({
      label: "Approve",
      path: `${base}/approve`,
      prompt: "Approve this challenger? It applies at the family's next restart.",
    });
  }
  if (isOwner && (ch.state === "review" || ch.state === "approved")) {
    buttons.push({
      label: "Force apply",
      path: `${base}/force-apply`,
      prompt: "Force-apply without validation? It is labelled UNVALIDATED, forced by Owner.",
    });
  }
  if (isOwner && !["promoted", "rejected", "retired"].includes(ch.state)) {
    buttons.push(
      {
        label: "Reject",
        path: `${base}/reject`,
        prompt: "Reject this challenger? This cannot be undone.",
      },
      {
        label: "Retire",
        path: `${base}/retire`,
        prompt: "Retire this challenger and its rule version? This cannot be undone.",
      },
    );
  }
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Challenger {ch.id}</h1>
      <p className="mt-2 text-sm">
        State: <strong>{ch.state}</strong> since {ch.state_d}. Origin: {ch.origin}. Version{" "}
        {ch.rule_version_id} against {ch.incumbent_version_id}.{" "}
        {ch.ready === 1 ? "All Critic checks passed." : "Not ready: a Critic check has not passed."}
      </p>
      <h2 className="mt-6 font-medium">History</h2>
      <ul className="mt-2 text-sm">
        {events.rows.map((e) => (
          <li key={Number(e.seq)}>
            {String(e.d)}: {e.from_state === null ? "new" : String(e.from_state)} to{" "}
            {String(e.to_state)} by {String(e.actor)}: {String(e.reason)}
          </li>
        ))}
      </ul>
      <h2 className="mt-6 font-medium">Critic checks</h2>
      {checks === null ? (
        <p className="text-sm">No Critic result yet.</p>
      ) : (
        <pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify(checks, null, 2)}</pre>
      )}
      {notes.rows.map((n) => (
        <p key={String(n.kind)} className="mt-2 text-sm">
          {String(n.kind)}: {String(n.text)}
        </p>
      ))}
      {isOwner ? (
        <ShadowResults path={`${base}/shadow-viewed`}>
          <p className="mt-2 text-sm">
            Shakedown sessions without a fault: {ch.shakedown_ok_sessions}. Last opened:{" "}
            {ch.shadow_viewed_d ?? "never"}.
          </p>
        </ShadowResults>
      ) : null}
      {buttons.length > 0 ? <OwnerActions buttons={buttons} /> : null}
    </main>
  );
}
