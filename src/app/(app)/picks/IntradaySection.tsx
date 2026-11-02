// "Intraday watch" (UXN-301, UXN-310): the day's candidates under their own accent. Everything here is
// shadow: a candidate is "Unrated - no history yet" and the stream is "unvalidated"; no number is a chance
// or a score. Prices are delayed (NFR-041): the move is a derived figure and each limit shows its quote time.
// A masked user sees "Stock A", words and times only.
import Link from "next/link";
import type { IntradayModel } from "@/lib/ui/loaders/pickAlerts";
import { Rail, FamilyBadge } from "@/components/ui/Family";
import { Masked, Money } from "@/components/ui/Values";
import { formatPpm } from "@/lib/view/format";
import {
  delayStatement,
  INTRADAY_EXPLAINER,
  INTRADAY_TITLE,
  INTRADAY_UNRATED,
  INTRADAY_UNVALIDATED,
} from "./text";

export function IntradaySection({
  model,
  compact = false,
}: {
  model: IntradayModel;
  compact?: boolean;
}) {
  const when = model.today
    ? model.lastScan
      ? `Last scan ${model.lastScan} Melbourne time.`
      : "No scan has run yet today."
    : "Outside market hours: showing the last session’s candidates and how they ended.";
  return (
    <section
      aria-labelledby="intraday-h"
      data-testid="intraday-section"
      className="flex min-w-0 flex-col gap-2 break-words"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="intraday-h" className="m-0 text-lg font-semibold">
          {INTRADAY_TITLE}
        </h2>
        <FamilyBadge code="id" label="Intraday" />
      </div>
      <p className="m-0 text-sm text-text-muted">{INTRADAY_EXPLAINER}</p>
      <p className="m-0 text-xs text-text-muted">
        {when} {INTRADAY_UNVALIDATED}
      </p>
      {model.rows.length === 0 ? (
        <p data-testid="intraday-empty" className="m-0 rounded-md border border-border p-3 text-sm">
          No candidates {model.today ? "yet today" : "to show"}.{" "}
          {model.lastScan ? `The last scan was at ${model.lastScan}.` : ""}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Intraday candidates">
          {model.rows.map((r) => (
            <li key={r.code} className="min-w-0" data-testid="intraday-row">
              <Rail
                hue="family-id"
                header={
                  <span className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-semibold">
                      {r.href ? (
                        <Link href={r.href} className="text-accent underline">
                          {r.stock}
                        </Link>
                      ) : (
                        r.stock
                      )}
                      {r.company ? (
                        <span className="font-normal text-text-muted"> · {r.company}</span>
                      ) : null}
                    </span>
                    <span
                      data-testid="unrated"
                      className="rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold"
                    >
                      {INTRADAY_UNRATED}
                    </span>
                  </span>
                }
              >
                <p className="m-0 text-sm break-words">{r.catalyst}</p>
                <p className="m-0 mt-1 text-xs text-text-muted">
                  Found {r.foundTime} · moved {formatPpm(r.movePpm, { digits: 1, sign: "always" })}{" "}
                  so far
                  {r.quoteTime ? ` (quote at ${r.quoteTime})` : ""}
                </p>
                {compact ? null : (
                  <p className="m-0 mt-1 text-xs">
                    Possible buy limit{" "}
                    {r.limit ? (
                      <Money micro={r.limit.micro} />
                    ) : model.masked ? (
                      <Masked />
                    ) : (
                      "not set"
                    )}
                    {" · stop-loss "}
                    {r.stop ? (
                      <Money micro={r.stop.micro} />
                    ) : model.masked ? (
                      <Masked />
                    ) : (
                      "not set"
                    )}
                  </p>
                )}
                {r.decisionOutcome && !model.today ? (
                  <p className="m-0 mt-1 text-xs text-text-muted">
                    How it ended: {r.decisionOutcome}
                  </p>
                ) : null}
              </Rail>
            </li>
          ))}
        </ul>
      )}
      {model.more > 0 ? (
        <p data-testid="intraday-more" className="m-0 text-sm text-text-muted">
          {model.more} more not shown.
        </p>
      ) : null}
      <p className="m-0 text-xs text-text-muted">{delayStatement(model.delayMin)}</p>
    </section>
  );
}
