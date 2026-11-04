// Movers check (D-886): the session's 20 biggest rises and 20 biggest falls (as on the Market tab) and
// what the six strategies did with each: held, an idea not bought (with the plain reasons), not
// followed, or avoided. Read-only, from the stored nightly data (src/lib/ui/loaders/moversCheck.ts);
// a masked viewer sees that the check is hidden, never a code or name.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { loadMoversCheck, type MoverRow, type MoverVerdict } from "@/lib/ui/loaders/moversCheck";
import { envFor } from "@/lib/ui/loaders/shell";
import { formatDate, formatPpm } from "@/lib/view/format";
import { StrategyTabs } from "../StrategyTabs";

export const dynamic = "force-dynamic";

const VERDICT: Record<MoverVerdict, { status: "ok" | "warn" | "bad" | "neutral"; word: string }> = {
  held: { status: "ok", word: "Held" },
  idea_not_bought: { status: "warn", word: "Idea, not bought" },
  not_followed: { status: "neutral", word: "Not followed" },
  no_rule: { status: "neutral", word: "No rule matched" },
  sold_by_stop: { status: "ok", word: "Sold by the stop" },
  held_in_fall: { status: "bad", word: "Held in the fall" },
  avoided: { status: "ok", word: "Avoided" },
};

function MoverList({ title, rows }: { title: string; rows: MoverRow[] }) {
  return (
    <Card title={title} headingLevel={2}>
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-text-muted">No company in this list for the session.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col divide-y divide-border p-0" aria-label={title}>
          {rows.map((r, i) => (
            <li key={r.code} className="flex min-w-0 flex-col gap-1 py-2" data-mover={r.verdict}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-6 text-right text-sm text-text-muted">{i + 1}</span>
                <Link
                  href={`/market/${encodeURIComponent(r.code)}`}
                  className="font-semibold text-accent"
                >
                  {r.code}
                </Link>
                {r.name ? (
                  <span className="min-w-0 truncate text-sm text-text-muted">{r.name}</span>
                ) : null}
                <span className="ml-auto font-mono text-sm">
                  <span aria-hidden="true">{r.changePpm >= 0 ? "▲ " : "▼ "}</span>
                  {formatPpm(r.changePpm, { sign: "always" })}
                </span>
                <Pill kind="status" value={VERDICT[r.verdict].status}>
                  {VERDICT[r.verdict].word}
                </Pill>
              </div>
              <p className="m-0 pl-9 text-sm">{r.text}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default async function MoversCheckPage() {
  const user = await requireUser("read", "/strategies/movers");
  const env = await envFor(user);
  const m = await loadMoversCheck(env);
  return (
    <main className="mx-auto flex max-w-5xl min-w-0 flex-col gap-6 px-4 py-6">
      <StrategyTabs current="movers" />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Movers check</h1>
        <p className="m-0 text-sm text-text-muted">
          The day&apos;s 20 biggest rises and 20 biggest falls, as on the Market tab, and what the
          six strategies did with each. Updated after every evening run.
        </p>
      </header>
      {m.hidden ? (
        <EmptyState motif="market" hue="strategies" title="Hidden for your access">
          This check names companies, so it is shown only to people who can see stock names.
        </EmptyState>
      ) : m.d === null ? (
        <EmptyState motif="market" hue="strategies" title="No prices stored yet">
          The check appears after the first evening run has stored prices.
        </EmptyState>
      ) : (
        <>
          <p className="m-0 text-sm font-medium" data-movers-summary="">
            {formatDate(m.d)}: held {m.summary.risesHeld} of the {m.rises.length} biggest rises;{" "}
            {m.summary.fallsHeld + m.summary.fallsSold} of the {m.falls.length} biggest falls were
            held ({m.summary.fallsSold} sold that day), the rest avoided.
          </p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MoverList title="Biggest rises" rows={m.rises} />
            <MoverList title="Biggest falls" rows={m.falls} />
          </div>
          <p className="m-0 text-xs text-text-muted">
            The strategies decide in the evening and trade at the next open, so a rise is compared
            with what they held and the ideas of the evening before. Simulated: practice money only.
          </p>
        </>
      )}
    </main>
  );
}
