// Claims to check (M13-lite WP6; UXN-295, LLM-069, KB-073, KB-075, D-529, D-594). Owner and Editor only
// (action review_claims; anyone else gets a 403 that is audit-logged by the guard). Every claim starts as an
// untested idea; nothing reaches testing until a person confirms the claim AND confirms the group it belongs
// to. Edits are saved as new versions. Every action here writes one audit event first.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadQueue } from "@/lib/ui/loaders/experts";
import { PageHead, Shell } from "../../learned/parts";
import { EXPERTS, OutLink } from "../parts";
import {
  bulkConfirmExpertAction,
  confirmClaimAction,
  confirmClusterAction,
  editClaimAction,
  mergeClaimAction,
  mergeClusterAction,
  parkClaimAction,
  rejectClaimAction,
} from "./actions";
import { EditClaim, MergeInto, OneAction } from "./QueueForm";

export const dynamic = "force-dynamic";

const PATH = "/reviews/experts/queue";
const TYPE_WORD: Record<string, string> = {
  method: "method",
  event_link: "event and price link",
  call: "call",
  risk_rule: "risk rule",
};

export default async function QueuePage() {
  const user = await requireUser("review_claims", PATH);
  const q = await loadQueue({
    mainDb: mainDb(),
    authDb: authDb(),
    user: { id: user.id, role: user.role },
  });

  return (
    <Shell>
      <PageHead title="Claims to check">
        Read each claim against its source. Confirming says the wording matches what the expert
        said; it does not say the method works. A confirmed group that fits one of our strategy
        families is then screened on the development history.
      </PageHead>
      <nav aria-label="Expert pages" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={EXPERTS} className="text-accent underline">
          Experts
        </Link>
        <Link href="/reviews/techniques" className="text-accent underline">
          Techniques
        </Link>
      </nav>
      {q.masked ? (
        <Banner tone="info">
          Your access hides stock names and codes in the text below. Editing is switched off while
          text is hidden, so a hidden word is never saved over the real one.
        </Banner>
      ) : null}

      <Card title="Groups to confirm" data-queue-groups="">
        {q.toConfirm.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">No group is waiting.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {q.toConfirm.map((k) => (
              <li
                key={k.id}
                className="flex min-w-0 flex-col gap-2 text-sm"
                data-queue-cluster={k.id}
              >
                <span className="font-medium">
                  {k.id} {k.name}
                </span>
                <span>{k.statement}</span>
                <span className="text-text-muted">
                  {k.supporters} supporting {k.supporters === 1 ? "claim" : "claims"};{" "}
                  {k.validFit && k.fitFamily
                    ? `fits strategy family ${k.fitFamily}, so it can be screened once confirmed`
                    : "does not fit a strategy family yet, so confirming it does not start a test"}
                  .
                </span>
                <div className="flex min-w-0 flex-col gap-2">
                  <OneAction
                    action={confirmClusterAction}
                    fields={{ cluster: k.id }}
                    label="Confirm group"
                    aria={`Confirm group ${k.id}`}
                    variant="default"
                  />
                  <MergeInto
                    action={mergeClusterAction}
                    fields={{ cluster: k.id }}
                    targets={q.targets.filter((t) => t.id !== k.id)}
                    idField="into"
                    label={`Merge ${k.id} into a confirmed group`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {q.total === 0 ? (
        <EmptyState title="No claims are waiting to be checked.">
          New claims arrive with the expert seed import.
        </EmptyState>
      ) : (
        q.experts.map((e) => (
          <Card
            key={e.id}
            title={`${e.name} (${e.claims.length})`}
            headingLevel={2}
            data-queue-expert={e.id}
            actions={
              <OneAction
                action={bulkConfirmExpertAction}
                fields={{ expert: e.id }}
                label="Confirm all"
                aria={`Confirm all ${e.claims.length} claims by ${e.name}`}
              />
            }
          >
            <ul className="m-0 flex list-none flex-col gap-5 p-0">
              {e.claims.map((c) => (
                <li
                  key={c.id}
                  className="flex min-w-0 flex-col gap-2 border-t border-border pt-4 text-sm first:border-t-0 first:pt-0"
                  data-queue-claim={c.id}
                >
                  <span className="text-xs text-text-muted">
                    {c.id}; {TYPE_WORD[c.type] ?? c.type}
                  </span>
                  <span>{c.statement}</span>
                  {c.formalisation ? (
                    <span className="text-text-muted">Draft rule: {c.formalisation}</span>
                  ) : null}
                  {c.claimedEdge ? (
                    <span className="text-text-muted">
                      <span className="font-medium">Claimed</span> result: {c.claimedEdge}
                    </span>
                  ) : null}
                  {c.vocabularyGap ? (
                    <span className="text-text-muted">
                      Needs an input we may lack: {c.vocabularyGap}
                    </span>
                  ) : null}
                  <span className="min-w-0 text-text-muted">
                    Sources:{" "}
                    {c.sources.length === 0 ? (
                      <NotMeasured />
                    ) : (
                      c.sources.map((s, i) => (
                        <span key={s.url}>
                          {i > 0 ? ", " : ""}
                          <OutLink href={s.url}>{s.title ?? s.url}</OutLink>
                        </span>
                      ))
                    )}
                  </span>
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <OneAction
                        action={confirmClaimAction}
                        fields={{ claim: c.id }}
                        label="Confirm"
                        aria={`Confirm claim ${c.id}`}
                        variant="default"
                      />
                      {q.masked ? null : (
                        <EditClaim
                          action={editClaimAction}
                          claimId={c.id}
                          statement={c.statement}
                          formalisation={c.formalisation}
                        />
                      )}
                    </div>
                    <OneAction
                      action={rejectClaimAction}
                      fields={{ claim: c.id }}
                      label="Reject"
                      aria={`Reject claim ${c.id}`}
                      variant="danger"
                      extra={{ name: "reason", placeholder: "Why (optional)" }}
                    />
                    <OneAction
                      action={parkClaimAction}
                      fields={{ claim: c.id }}
                      label="Park"
                      aria={`Park claim ${c.id}`}
                      extra={{ name: "reason", placeholder: "Why (optional)" }}
                    />
                    <MergeInto
                      action={mergeClaimAction}
                      fields={{ claim: c.id }}
                      targets={q.targets}
                      idField="cluster"
                      label={`Put claim ${c.id} into a confirmed group`}
                      withRole
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </Shell>
  );
}
