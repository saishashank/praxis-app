// One expert (M13-lite WP6; UXN-293, PRD-034, D-521, D-532). Profile, links, licence status in words, red
// flags (text and source for Owner and Editor; a count only for a Viewer), "Reach, not skill", our short
// summaries of their items with a link out, their claims with status and grade, the groups those claims
// support or contradict, the scorecard with n and interval, and paper calls (codes masked for a masked user).
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { AlertIcon } from "@/components/ui/icons";
import { Banner, EmptyState } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { CLAIM_STATUSES } from "@/lib/experts/types";
import {
  CLAIM_STATUS_WORD,
  loadExpertDetail,
  STATUS_WORD,
  type CallRowView,
  type ExpertClaimView,
} from "@/lib/ui/loaders/experts";
import { PageHead, Shell } from "../../learned/parts";
import { EXPERTS, OutLink, PageLink, TECHNIQUES, pct } from "../parts";

export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/;
const TYPE_WORD: Record<string, string> = {
  method: "method",
  event_link: "event and price link",
  call: "call",
  risk_rule: "risk rule",
};

const claimCols: Column<ExpertClaimView>[] = [
  {
    key: "claim",
    header: "Claim",
    cell: (c) => (
      <span className="flex min-w-0 flex-col gap-1">
        <span>{c.statement}</span>
        {c.formalisation ? (
          <span className="text-xs text-text-muted">Draft rule: {c.formalisation}</span>
        ) : null}
        {c.claimedEdge ? (
          <span className="text-xs text-text-muted">
            <span className="font-medium">Claimed</span> result: {c.claimedEdge}
          </span>
        ) : null}
      </span>
    ),
  },
  { key: "type", header: "Kind", cell: (c) => TYPE_WORD[c.type] ?? c.type },
  { key: "status", header: "Status", cell: (c) => CLAIM_STATUS_WORD[c.status] },
  {
    key: "grade",
    header: "Evidence grade",
    cell: (c) => (
      <span title="L0 is an untested idea; L1 passed the development screen">{c.grade}</span>
    ),
  },
  {
    key: "clusters",
    header: "Groups",
    cell: (c) =>
      c.clusters.length === 0 ? (
        <NotMeasured>not grouped yet</NotMeasured>
      ) : (
        c.clusters.map((k) => `${k.id} (${k.role})`).join(", ")
      ),
  },
];

const callCols: Column<CallRowView>[] = [
  { key: "code", header: "Code", cell: (c) => <span className="font-mono">{c.code}</span> },
  { key: "market", header: "Market", cell: (c) => c.market },
  { key: "dir", header: "Direction", cell: (c) => c.direction },
  { key: "day", header: "Called", cell: (c) => c.callDay ?? <NotMeasured /> },
  { key: "h", header: "Horizon (sessions)", align: "right", cell: (c) => c.horizonSessions },
  { key: "state", header: "State", cell: (c) => c.stateText },
  {
    key: "vs",
    header: "Against the market",
    align: "right",
    cell: (c) => (c.vsMarketPct === null ? <NotMeasured /> : pct(c.vsMarketPct)),
  },
  {
    key: "luck",
    header: "Share of the universe that did better",
    align: "right",
    cell: (c) => (c.luckPct === null ? <NotMeasured /> : `${c.luckPct}%`),
  },
];

export default async function ExpertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser("read", EXPERTS);
  if (!ID_RE.test(id)) notFound();
  const out = await loadExpertDetail(
    { mainDb: mainDb(), authDb: authDb(), user: { id: user.id, role: user.role } },
    id,
  );
  if (out === null) notFound();
  const e = out.data;
  const groups = new Map<string, { name: string; roles: Set<string> }>();
  for (const c of e.claims)
    for (const k of c.clusters) {
      const g = groups.get(k.id) ?? { name: k.name, roles: new Set<string>() };
      g.roles.add(k.role);
      groups.set(k.id, g);
    }

  return (
    <Shell>
      <PageHead title={e.name}>
        {STATUS_WORD[e.status] ?? e.status}
        {e.noFeed ? ". A reference author: nothing is followed automatically." : ""}
      </PageHead>
      {out.masked ? (
        <Banner tone="info">
          Your access hides stock names and codes in the text below, and shows dates as weeks.
        </Banner>
      ) : null}

      <Card title="Profile">
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="text-text-muted">Platforms</dt>
          <dd className="m-0">{e.platforms.join(", ") || <NotMeasured />}</dd>
          <dt className="text-text-muted">Focus</dt>
          <dd className="m-0">{e.focus.join(", ") || <NotMeasured />}</dd>
          <dt className="text-text-muted">Markets</dt>
          <dd className="m-0">{e.markets.join(", ") || <NotMeasured />}</dd>
          <dt className="text-text-muted">Licence or registration</dt>
          <dd className="m-0" data-licence="">
            {e.licence}
          </dd>
          <dt className="text-text-muted">Links</dt>
          <dd className="m-0 flex min-w-0 flex-col gap-1">
            {e.homeUrls.length === 0 ? (
              <NotMeasured />
            ) : (
              e.homeUrls.map((u) => (
                <OutLink key={u} href={u}>
                  {u}
                </OutLink>
              ))
            )}
          </dd>
        </dl>
      </Card>

      <Card title="Red flags" data-red-flag-card="">
        {e.redFlags.count === 0 ? (
          <p className="m-0 text-sm text-text-muted">None noted.</p>
        ) : e.redFlagsVisible ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {e.redFlags.items.map((f) => (
              <li key={f.sourceUrl + f.text} className="flex min-w-0 flex-col gap-1">
                <span className="inline-flex items-start gap-2">
                  <AlertIcon aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
                  <span>{f.text}</span>
                </span>
                <span className="text-xs text-text-muted">
                  Noted {f.notedDay ?? "on an unknown date"}. Source:{" "}
                  <OutLink href={f.sourceUrl}>{f.sourceUrl}</OutLink>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p
            className="m-0 inline-flex items-center gap-2 text-sm"
            data-red-flags={e.redFlags.count}
          >
            <AlertIcon aria-hidden="true" className="text-warning" />
            {e.redFlags.count} {e.redFlags.count === 1 ? "red flag is" : "red flags are"} noted. The
            details are shown to the Owner and Editors.
          </p>
        )}
      </Card>

      <Card title="Reach, not skill">
        <p className="m-0 text-sm" data-reach="">
          {e.reach.audienceSize === null
            ? "Audience size not recorded."
            : `Audience size ${e.reach.audienceSize.toLocaleString("en-AU")}${
                e.reach.audienceDay ? ` (${e.reach.audienceDay})` : ""
              }.`}{" "}
          {e.reachLine}
        </p>
      </Card>

      <Card title="Scorecard">
        <p className="m-0 text-sm" data-scorecard={e.scored ? "scored" : "insufficient"}>
          {e.scoreText}
        </p>
        {e.passShare ? (
          <p className="m-0 mt-1 text-sm">
            n = {e.passShare.n} tested claims; {e.passShare.k} passed screening. A range of{" "}
            {e.passShare.lowerPct}% to {e.passShare.upperPct}% fits that count (90% interval).
          </p>
        ) : null}
        <p className="m-0 mt-1 text-sm text-text-muted">
          {CLAIM_STATUSES.filter((s) => e.claimsByStatus[s] > 0)
            .map((s) => `${e.claimsByStatus[s]} ${CLAIM_STATUS_WORD[s]}`)
            .join(", ") || "No claims yet."}
        </p>
        <p className="m-0 mt-1 text-xs text-text-muted">{e.caption}</p>
      </Card>

      <Card title="Claims">
        <DataTable
          caption="Claims by this expert"
          columns={claimCols}
          rows={e.claims}
          rowKey={(c) => c.id}
          empty={<EmptyState compact title="No claims recorded for this expert." />}
        />
      </Card>

      <Card title="Groups these claims belong to">
        {groups.size === 0 ? (
          <p className="m-0 text-sm text-text-muted">None yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {[...groups.entries()].map(([gid, g]) => (
              <li key={gid}>
                <PageLink href={`${TECHNIQUES}#${gid}`}>
                  {gid} {g.name}
                </PageLink>{" "}
                <span className="text-text-muted">({[...g.roles].join(" and ")})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Items we read">
        {e.items.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">No items recorded.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm">
            {e.items.map((i) => (
              <li key={i.id} className="flex min-w-0 flex-col gap-1">
                <span>
                  <OutLink href={i.url}>{i.title ?? i.url}</OutLink>
                  <span className="text-text-muted">
                    {" "}
                    ({i.platform}
                    {i.day ? `, ${i.day}` : ""})
                  </span>
                </span>
                {i.summary ? (
                  <span className="text-text-muted">Our summary: {i.summary}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Paper calls">
        <DataTable
          caption="Calls by this expert, followed on paper only"
          columns={callCols}
          rows={e.calls}
          rowKey={(c) => c.claimId}
          empty={<EmptyState compact title="No calls recorded for this expert." />}
        />
        <p className="m-0 mt-2 text-xs text-text-muted">
          Paper calls are never orders and never picks. {e.caption}
        </p>
      </Card>
    </Shell>
  );
}
