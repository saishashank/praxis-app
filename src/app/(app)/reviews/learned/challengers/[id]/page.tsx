// One challenger (UX-070/071, KB-040, UXN-201; D-125): state, what it changes against the live version,
// history, Critic checks and the Owner's buttons with a confirmation. All signed-in roles read; only
// the Owner sees the buttons.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadChallengerView } from "@/lib/ui/loaders/knowledgeViews";
import { Card } from "@/components/ui/Card";
import { OwnerActions, ShadowResults, type OwnerButton } from "../../OwnerActions";
import { CritiqueBlock, familyHref, LEARNED, PageHead, Shell, StageText } from "../../parts";

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
  const user = await requireUser("read", `${LEARNED}/challengers/${encodeURIComponent(id)}`);
  const env = await envFor(user);
  const ch = await loadChallengerView(env, id);
  if (ch === null) notFound();

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
        danger: true,
      },
      {
        label: "Retire",
        path: `${base}/retire`,
        prompt: "Retire this challenger and its rule version? This cannot be undone.",
        danger: true,
      },
    );
  }

  return (
    <Shell>
      <PageHead title={`Challenger ${ch.id}`}>
        Stage <StageText stage={ch.state} /> since {ch.stateDay}. Origin: {ch.origin}. Version{" "}
        {ch.ruleVersionId} against {ch.incumbentId} in{" "}
        <Link href={familyHref(ch.family)} className="text-accent underline">
          family {ch.family}
        </Link>
        . {ch.ready ? "All Critic checks passed." : "Not ready: a Critic check has not passed."}
      </PageHead>
      <Card title="What it changes">
        {ch.changes.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">No parameter differs from the live version.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {ch.changes.map((c) => (
              <li key={c.key} className="min-w-0 break-words">
                <span className="font-medium">{c.key.replace(/_/g, " ")}</span>:{" "}
                <span className="font-mono">{c.from}</span> to{" "}
                <span className="font-mono">{c.to}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 mt-2 text-sm">
          <Link
            href={`${LEARNED}/compare?ids=${encodeURIComponent(ch.id)},${encodeURIComponent(ch.incumbentId)}`}
            className="text-accent underline"
          >
            Compare with the live version
          </Link>
        </p>
        {buttons.length > 0 ? <OwnerActions buttons={buttons} label="Owner actions" /> : null}
      </Card>
      <Card title="History">
        <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {ch.events.map((e) => (
            <li key={e.seq} className="min-w-0 break-words">
              {e.day}: {e.from === null ? "new" : e.from} to {e.to}
              {e.actor === null ? "" : ` by ${e.actor}`}: {e.reason}
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Critic checks">
        <CritiqueBlock critique={ch.critique} masked={ch.masked} />
      </Card>
      {isOwner ? (
        <ShadowResults path={`${base}/shadow-viewed`}>
          <p className="m-0">
            Shakedown sessions without a fault: {ch.shakedownSessions}. Last opened:{" "}
            {ch.shadowViewedDay ?? "never"}.
          </p>
        </ShadowResults>
      ) : null}
    </Shell>
  );
}
