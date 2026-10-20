// One strategy family (UX-070/071, UXN-201): the live version, every version with its parameters
// (bounds shown), what changed from its parent, lessons and challengers of the family, the family
// document and the change ledger. The Owner can roll back to a version that was live and write a
// new version (it enters as a challenger, KB-050) through the audited D-125 routes.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { isFamilyId, loadFamily, loadLedger } from "@/lib/ui/loaders/knowledgeViews";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { EmptyState, ShowDetails } from "@/components/ui/States";
import { FamilyForm } from "../../FamilyForm";
import { OwnerActions } from "../../OwnerActions";
import { ChallengerLine, LessonCard, LEARNED, PageHead, Shell } from "../../parts";

export const dynamic = "force-dynamic";

export default async function FamilyPage({ params }: { params: Promise<{ family: string }> }) {
  const { family } = await params;
  if (!isFamilyId(family)) notFound();
  const user = await requireUser("read", `${LEARNED}/families/${family}`);
  const env = await envFor(user);
  const [view, ledger] = await Promise.all([loadFamily(env, family), loadLedger(env, family)]);
  const isOwner = user.role === "owner";
  const live = view.versions.find((v) => v.id === view.liveId) ?? null;

  return (
    <Shell>
      <PageHead title={`Strategy family ${family}`}>
        {view.liveId === null ? "No live version yet." : `Live version: ${view.liveId}.`}
      </PageHead>
      {view.state === "empty" ? (
        <EmptyState title="Nothing recorded for this family yet">
          Versions, lessons and challengers appear after the starting rules are registered and the
          weekly run has looked at this family.
        </EmptyState>
      ) : null}

      <Card title="Version history">
        {view.versions.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">No versions yet.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {view.versions.map((v) => (
              <li key={v.id} data-testid="version" className="min-w-0 text-sm break-words">
                <p className="m-0 font-medium">
                  <span className="font-mono">{v.id}</span> — {v.status}, from {v.origin},
                  registered {v.registeredDay}
                </p>
                {v.changes.length > 0 ? (
                  <ul className="m-0 mt-1 list-disc pl-5">
                    {v.changes.map((c) => (
                      <li key={c.key}>
                        {c.key.replace(/_/g, " ")}: <span className="font-mono">{c.from}</span> to{" "}
                        <span className="font-mono">{c.to}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 text-text-muted">
                    {v.parent === null
                      ? "Starting version."
                      : "Same numbers as the version before."}
                  </p>
                )}
                <ShowDetails summary="Show all numbers and their allowed range">
                  <DataTable
                    caption={`Numbers of ${v.id}`}
                    rows={v.params}
                    rowKey={(p) => p.key}
                    columns={[
                      { key: "key", header: "Number", cell: (p) => p.key.replace(/_/g, " ") },
                      { key: "value", header: "Value", cell: (p) => p.value, align: "right" },
                      {
                        key: "range",
                        header: "Allowed range",
                        cell: (p) =>
                          p.min === null || p.max === null ? "n/a" : `${p.min} to ${p.max}`,
                      },
                    ]}
                  />
                </ShowDetails>
                {isOwner && v.wasLive && v.id !== view.liveId ? (
                  <OwnerActions
                    label={`Owner actions for ${v.id}`}
                    buttons={[
                      {
                        label: `Roll back to ${v.id}`,
                        path: `/api/learning/families/${encodeURIComponent(family)}/rollback`,
                        body: { to_version: v.id },
                        prompt: `Roll ${family} back to ${v.id}? The label resets to UNVALIDATED and it applies at the next restart.`,
                        danger: true,
                      },
                    ]}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {isOwner && live !== null ? (
        <Card title="Write a new version">
          <p className="m-0 mb-3 text-sm text-text-muted">
            Change numbers of the live version. The result starts as a challenger and must pass the
            same checks before it is used.
          </p>
          <FamilyForm family={family} params={live.params} />
        </Card>
      ) : null}

      <Card title="Lessons">
        {view.lessons.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">No lessons for this family yet.</p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
            {view.lessons.map((l) => (
              <li key={l.id} className="min-w-0">
                <LessonCard lesson={l} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Challengers">
        {view.challengers.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">No challengers for this family.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {view.challengers.map((c) => (
              <ChallengerLine key={c.id} c={c} />
            ))}
          </ul>
        )}
      </Card>

      {view.document ? (
        <Card title={view.document.title}>
          <ShowDetails summary="Show the family document">
            <p className="m-0 text-sm whitespace-pre-wrap break-words">{view.document.body}</p>
          </ShowDetails>
        </Card>
      ) : null}

      <Card title="Changes to this family">
        <DataTable
          caption={`Changes to family ${family}`}
          rows={ledger}
          rowKey={(r) => String(r.id)}
          empty={<p className="m-0 text-sm text-text-muted">No changes yet.</p>}
          columns={[
            { key: "day", header: "When", cell: (r) => r.day },
            { key: "kind", header: "What", cell: (r) => r.kind },
            { key: "target", header: "Where", cell: (r) => r.target },
          ]}
        />
      </Card>

      <p className="m-0 text-sm">
        <Link href={LEARNED} className="text-accent underline">
          Back to what the system learned
        </Link>
      </p>
    </Shell>
  );
}
