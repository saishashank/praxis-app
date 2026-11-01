// Expert directory (M13-lite WP6; UXN-292, KB-074, PRD-034, D-532). Every role reads it. The list is sorted by
// tested evidence only: the scorecard decides, audience size never does ("popularity is not skill"). A card
// with too few tested claims says so in words. Red flags show as an icon and a count here; the text is on
// the expert's own page and only for Owner and Editor (D-521).
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { AlertIcon } from "@/components/ui/icons";
import { Banner, EmptyState } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import {
  CLAIM_STATUS_WORD,
  loadExpertDirectory,
  parseExpertQuery,
  STATUS_WORD,
  type ExpertListRow,
} from "@/lib/ui/loaders/experts";
import { CLAIM_STATUSES } from "@/lib/experts/types";
import { PageHead, Shell } from "../learned/parts";
import { detailHref, EXPERTS as PATH, QUEUE, TECHNIQUES } from "./parts";

export const dynamic = "force-dynamic";

const FIELD = "min-h-6 w-full rounded-md border border-border bg-bg p-2 text-text";
type SP = Record<string, string | string[] | undefined>;

const claimsText = (r: ExpertListRow): string =>
  CLAIM_STATUSES.filter((s) => r.claimsByStatus[s] > 0)
    .map((s) => `${r.claimsByStatus[s]} ${CLAIM_STATUS_WORD[s]}`)
    .join(", ");

const columns: Column<ExpertListRow>[] = [
  {
    key: "name",
    header: "Expert",
    cell: (r) => (
      <Link href={detailHref(r.id)} className="text-accent underline">
        {r.name}
      </Link>
    ),
  },
  { key: "platforms", header: "Platforms", cell: (r) => r.platforms.join(", ") || <NotMeasured /> },
  { key: "focus", header: "Focus", cell: (r) => r.focus.join(", ") || <NotMeasured /> },
  { key: "markets", header: "Markets", cell: (r) => r.markets.join(", ") || <NotMeasured /> },
  { key: "status", header: "Status", cell: (r) => STATUS_WORD[r.status] ?? r.status },
  {
    key: "claims",
    header: "Claims by status",
    cell: (r) => (r.claimTotal === 0 ? <NotMeasured /> : claimsText(r)),
  },
  {
    key: "score",
    header: "Scorecard",
    cell: (r) => <span data-scorecard={r.scored ? "scored" : "insufficient"}>{r.scoreText}</span>,
  },
  {
    key: "flags",
    header: "Red flags",
    cell: (r) =>
      r.redFlags > 0 ? (
        <span className="inline-flex items-center gap-1 text-warning" data-red-flags={r.redFlags}>
          <AlertIcon aria-hidden="true" />
          <span>
            {r.redFlags}
            <span className="sr-only"> red flags, open the expert for the sources</span>
          </span>
        </span>
      ) : (
        <span className="text-text-muted">none noted</span>
      ),
  },
  { key: "last", header: "Latest item", cell: (r) => r.lastItemD ?? <NotMeasured /> },
];

export default async function ExpertsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", PATH);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const query = parseExpertQuery(q);
  if (query === null) notFound();
  const dir = await loadExpertDirectory(
    { mainDb: mainDb(), authDb: authDb(), user: { id: user.id, role: user.role } },
    query,
  );
  const filtered = Object.values(query).some((v) => v !== undefined);

  return (
    <Shell>
      <PageHead title="Experts">
        People whose published methods we have written down as claims. Every claim starts as an
        unproven idea. The list is ordered by how well their claims did in testing; audience size is
        never used.
      </PageHead>
      {dir.masked ? (
        <Banner tone="info">
          Your access hides stock names and codes in the text below, and shows dates as weeks.
        </Banner>
      ) : null}
      <nav
        aria-label="Expert pages"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
      >
        <Link href={TECHNIQUES} className="text-accent underline">
          Techniques
        </Link>
        <Link href="/reviews/learned" className="text-accent underline">
          What the system learned
        </Link>
        {dir.canReview ? (
          <Link href={QUEUE} className="text-accent underline">
            Claims to check ({dir.toCheck})
          </Link>
        ) : null}
      </nav>

      <Card title="Filter">
        <form method="get" action={PATH} className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          {(
            [
              ["focus", "Focus", dir.options.focus],
              ["market", "Market", dir.options.market],
              ["platform", "Platform", dir.options.platform],
            ] as const
          ).map(([name, label, opts]) => (
            <label key={name} className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium">{label}</span>
              <select name={name} defaultValue={query[name] ?? ""} className={FIELD}>
                <option value="">All</option>
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">Status</span>
            <select name="status" defaultValue={query.status ?? ""} className={FIELD}>
              <option value="">All</option>
              {Object.entries(STATUS_WORD).map(([k, w]) => (
                <option key={k} value={k}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit">Filter</Button>
            {filtered ? (
              <Link href={PATH} className="inline-flex min-h-6 items-center text-accent underline">
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {dir.empty ? (
        <EmptyState title="No experts have been added yet.">
          The Owner adds them with the seed import; nothing is fetched from the web.
        </EmptyState>
      ) : (
        <DataTable
          caption="Experts, ordered by tested evidence"
          columns={columns}
          rows={dir.rows}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No expert matches those filters." />}
        />
      )}
      <p className="m-0 text-xs text-text-muted">
        Order: experts with enough tested claims first, then by how many of their tested claims
        passed screening, then by how their paper calls compared with the market. Ties go by name. A
        claim passing screening is a lead to test further, not a forecast.
      </p>
    </Shell>
  );
}
