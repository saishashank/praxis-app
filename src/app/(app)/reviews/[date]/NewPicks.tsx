// Section 7a "New picks" of the in-app Evening Review (UXN-044). Stored picks of the review date, no
// recomputation. A masked user gets "Stock A", no company, no prices and ISO weeks (loader).
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import type { NewPicksView } from "@/lib/ui/loaders/reviews";

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function NewPicks({ picks, masked }: { picks: NewPicksView; masked: boolean }) {
  return (
    <section aria-labelledby="mr-newpicks" className="flex flex-col gap-3">
      <h2 id="mr-newpicks" className="text-xl font-semibold">
        New picks
      </h2>
      {picks.none ? (
        <EmptyState
          compact
          motif="picks"
          hue="picks"
          title="No picks were published for this review."
        />
      ) : (
        picks.profiles.map((p) => (
          <Card key={p.profile} title={title(p.profile)} headingLevel={3}>
            {p.successLine ? <p className="m-0 mb-2 text-sm">{p.successLine}</p> : null}
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {p.picks.map((x) => (
                <li key={x.rank} className="min-w-0 break-words text-sm">
                  <p className="m-0 font-semibold">
                    {x.stock}
                    {x.company ? ` · ${x.company}` : ""}
                  </p>
                  {masked ? (
                    <p className="m-0 text-text-muted">
                      Prices are hidden for your access level. Valid until week {x.validUntil}.
                    </p>
                  ) : (
                    <p className="m-0">
                      Buy up to {x.buyUpTo ? <Money micro={x.buyUpTo.micro} /> : <NotMeasured />} ·
                      Stop-loss {x.stop ? <Money micro={x.stop.micro} /> : <NotMeasured />} · Aim{" "}
                      {x.aim ? <Money micro={x.aim.micro} /> : <NotMeasured />} · Valid until{" "}
                      {x.validUntil}
                      {x.timeFrameWeeks !== null ? ` · about ${x.timeFrameWeeks} weeks` : ""}
                    </p>
                  )}
                  {x.basedOn ? <p className="m-0 text-text-muted">Based on: {x.basedOn}</p> : null}
                  <Link href={x.href} className="text-accent underline">
                    Why this pick
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
      <p className="m-0 text-xs text-text-muted">{picks.honesty}</p>
      {!masked && !picks.none ? <SimulatedLabel /> : null}
    </section>
  );
}
