// Expert sources (M22 E2; KB-082, UXN-296, D-1480). Owner only. What the job reads and what it does not: per expert the state
// of each source in plain words, when it was last read, how many items we hold and how many wait for a model to look at
// them; and the people the job found (named by two tracked experts' own headlines) with approve, dismiss and snooze. Nothing
// here fetches anything. The page shows links and titles only, never a post's text.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { mainDb } from "@/lib/db/client";
import { loadSourcesView } from "@/lib/experts/poll/view";
import { melbourneDate } from "@/lib/view/active";
import { PageHead, Shell } from "../../learned/parts";
import { detailHref, EXPERTS } from "../parts";
import { candidateAction } from "./actions";
import { CandidateForm } from "./CandidateForm";

export const dynamic = "force-dynamic";
const PATH = "/reviews/experts/sources";

const dayWords = (d: string | null): string => (d === null ? "not yet" : d);

export default async function SourcesPage() {
  await requireUser("admin", PATH);
  const today = melbourneDate(new Date().toISOString()) ?? "";
  const v = await loadSourcesView(mainDb(), today);
  const open = v.candidates.filter((c) => c.snoozedUntil === null);
  const snoozed = v.candidates.length - open.length;
  return (
    <Shell>
      <PageHead title="Expert sources">
        Where the system reads experts&apos; public headlines from, and who it has found. A source
        is read only when its site allows it. Only the headline, the link and the time are kept.
      </PageHead>
      <nav
        aria-label="Expert pages"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
      >
        <Link href={EXPERTS} className="text-accent underline">
          Experts
        </Link>
      </nav>

      <Card title="Sources we read">
        <p className="m-0 mb-3 text-sm text-text-muted">
          Last daily read: {dayWords(v.lastPollDay)}. Last search for new people:{" "}
          {dayWords(v.lastDiscoveryDay)}.{" "}
          {v.waitingTotal === 0
            ? "No headlines are waiting."
            : `${v.waitingTotal} ${v.waitingTotal === 1 ? "headline is" : "headlines are"} waiting for a model to look at.`}
        </p>
        {v.experts.length === 0 ? (
          <EmptyState title="No experts are being tracked yet.">
            The Owner adds them with the seed import; nothing is read from the web until a source
            has been checked.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Sources by expert</caption>
              <thead>
                <tr className="text-text-muted">
                  <th scope="col">Expert</th>
                  <th scope="col">Sources</th>
                  <th scope="col">Last read</th>
                  <th scope="col">Items</th>
                  <th scope="col">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {v.experts.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td>
                      <Link href={detailHref(e.id)} className="text-accent underline">
                        {e.name}
                      </Link>
                    </td>
                    <td>
                      {e.sources.length === 0 ? (
                        <span className="text-text-muted">No sources listed.</span>
                      ) : (
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">
                          {e.sources.map((s) => (
                            <li key={s.label} data-reading={s.reading ? "yes" : "no"}>
                              <span className="font-medium">{s.label}</span>
                              <span className="text-text-muted"> — {s.words}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>{dayWords(e.lastRead)}</td>
                    <td>{e.items}</td>
                    <td>{e.waiting}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="People the system found">
        <p className="m-0 mb-3 text-sm text-text-muted">
          Named in the headlines of at least two experts we track. Nobody is added until you
          approve. Red flags are not checked automatically: check them by hand before approving.
        </p>
        {open.length === 0 ? (
          <EmptyState title="Nobody is waiting for a decision.">
            {snoozed > 0
              ? `${snoozed} ${snoozed === 1 ? "person is" : "people are"} snoozed and will come back.`
              : "The search runs on Sundays."}
          </EmptyState>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {open.map((c) => (
              <li key={c.id} className="flex min-w-0 flex-col gap-2" data-candidate={c.id}>
                <div>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-text-muted">
                    {" "}
                    {c.mentions === 0
                      ? " — found by the weekly search."
                      : ` — named ${c.mentions} ${c.mentions === 1 ? "time" : "times"} by ${c.namedBy} ${c.namedBy === 1 ? "expert" : "experts"}${c.seenD === null ? "" : `, last seen ${c.seenD}`}.`}{" "}
                    Red flags: manual check needed.
                  </span>
                </div>
                <CandidateForm action={candidateAction} expertId={c.id} />
              </li>
            ))}
          </ul>
        )}
        {open.length > 0 && snoozed > 0 ? (
          <p className="m-0 mt-3 text-sm text-text-muted">
            {snoozed} {snoozed === 1 ? "more person is" : "more people are"} snoozed.
          </p>
        ) : null}
      </Card>
    </Shell>
  );
}
