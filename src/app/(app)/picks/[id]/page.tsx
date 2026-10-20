// Why this pick (UXN-042): numbered Based-on reasons, "How these numbers were worked out" in plain
// words, the factor data behind a "Show details", the tracked outcome and the honesty line. Stored
// values only; a masked user sees no company, prices, size or exact dates (DAT-124).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadPickDetail } from "@/lib/ui/loaders/picks";
import { Breadcrumb } from "@/components/ui/Nav";
import { ShowDetails } from "@/components/ui/States";
import { Masked, Money, SimulatedLabel } from "@/components/ui/Values";
import { ValidationBadge } from "@/components/ui/Badges";
import { formatDate, formatPpm } from "@/lib/view/format";
import { pickProfilesConfig } from "../data";
import {
  exitWords,
  honestyLine,
  pct,
  profileLabel,
  profileRules,
  STOP_GAP_HOVER,
  stateText,
  timeFrameText,
} from "../text";

export const dynamic = "force-dynamic";

export default async function WhyThisPickPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const user = await requireUser("read", "/picks/[id]");
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  const env = await envFor(user);
  const detail = await loadPickDetail(env, id);
  if (detail === null) notFound();
  const { pick, masked, profile } = detail;
  const rules = profileRules(await pickProfilesConfig(env.main), profile);
  const frame = timeFrameText(pick.timeFrameSessions);
  const o = detail.outcome;

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <Breadcrumb
        backHref="/picks"
        items={[{ label: "Picks", href: "/picks" }, { label: "Why this pick" }]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Why this pick: {pick.stock}</h1>
        {pick.company ? <p className="m-0 text-text-muted">{pick.company}</p> : null}
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <span>
            {profileLabel(profile)} · {pick.familyName} · {stateText(pick.outcome)}
          </span>
          <ValidationBadge label={pick.label} />
        </p>
      </header>

      <section aria-labelledby="based-h" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="based-h" className="m-0 mb-2 text-base font-semibold">
          Based on
        </h2>
        {pick.basedOn.length === 0 ? (
          <p className="m-0 text-text-muted italic">No reasons were stored with this pick.</p>
        ) : (
          <ol className="m-0 list-decimal pl-5">
            {pick.basedOn.map((b, i) => (
              <li key={i} className="break-words">
                {b}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="how-h" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="how-h" className="m-0 mb-2 text-base font-semibold">
          How these numbers were worked out
        </h2>
        <ul className="m-0 list-none space-y-2 p-0 text-sm">
          <li>
            <strong>Buy zone:</strong> tonight&apos;s closing price plus a small allowance for price
            slip. Buy up to{" "}
            {masked || !pick.buyUpTo ? <Masked /> : <Money micro={pick.buyUpTo.micro} />}, valid
            until {masked ? pick.validUntil : formatDate(pick.validUntil)}.
          </li>
          <li>
            <strong>Stop-loss:</strong> the strategy&apos;s own rule
            {pick.stopPpm !== null ? `, ${pct(pick.stopPpm)} from the reference price` : ""}
            {masked || !pick.stop ? null : (
              <>
                , at <Money micro={pick.stop.micro} />
              </>
            )}
            . {STOP_GAP_HOVER}
          </li>
          <li>
            <strong>Aim and time frame:</strong> the strategy takes profit
            {pick.aimPpm !== null ? ` at ${pct(pick.aimPpm)}` : ""}
            {pick.aimReachPpm !== null
              ? `; ${formatPpm(pick.aimReachPpm, { digits: 0 })} of ${pick.scenario?.n ?? "the"} past similar trades reached it`
              : ""}
            {frame ? `; they were typically held ${frame}` : ""}.
          </li>
          <li>
            <strong>Past similar trades:</strong>{" "}
            {pick.scenario
              ? `bad case ${pct(pick.scenario.badPpm)}, typical ${pct(pick.scenario.typicalPpm)}, good case ${pct(pick.scenario.goodPpm)}. Historical range, not a forecast.`
              : "not enough similar cases yet."}
          </li>
          <li>
            <strong>Size:</strong>{" "}
            {rules
              ? `your ${profileLabel(profile)} rules: no more than ${rules.maxPct}% in one company and no more than ${rules.riskPct}% of the portfolio at risk. `
              : ""}
            {masked || !pick.size || !pick.riskAtStop ? (
              <Masked />
            ) : (
              <>
                Up to <Money micro={pick.size.micro} />; if the stop-loss is hit you would lose
                about <Money micro={pick.riskAtStop.micro} /> plus fees.
              </>
            )}
          </li>
        </ul>
        {masked ? null : (
          <p className="m-0 mt-2">
            <SimulatedLabel />
          </p>
        )}
      </section>

      <section aria-labelledby="out-h" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="out-h" className="m-0 mb-2 text-base font-semibold">
          What happened
        </h2>
        {o === null ? (
          <p className="m-0 text-text-muted italic">Not tracked yet.</p>
        ) : (
          <p className="m-0 text-sm">
            {stateText(o)}
            {o.entry ? (
              <>
                {" at "}
                <Money micro={o.entry.micro} />
              </>
            ) : null}
            {o.exitReason ? `; ${exitWords(o.exitReason)}` : ""}
            {o.state === "closed" ? `; result after costs ${pct(o.netPpm)}` : ""}.
          </p>
        )}
        {pick.cardHref ? (
          <p className="m-0 mt-2 text-sm">
            <Link href={pick.cardHref} className="text-accent underline">
              Open the Decision Card
            </Link>
          </p>
        ) : null}
        <p className="m-0 mt-2 text-sm">
          <Link
            href={`/picks/track-record?profile=${encodeURIComponent(profile)}`}
            className="text-accent underline"
          >
            Track record
          </Link>
        </p>
      </section>

      <ShowDetails>
        {detail.factors.length === 0 ? (
          <p className="m-0 text-text-muted italic">No factor data was stored with this pick.</p>
        ) : (
          <table className="w-full table-fixed border-collapse text-sm">
            <caption className="sr-only">Factor data behind this pick</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-border p-2 text-left">
                  Factor
                </th>
                <th scope="col" className="border-b border-border p-2 text-left">
                  Value
                </th>
                <th scope="col" className="border-b border-border p-2 text-right">
                  Similar cases
                </th>
                <th scope="col" className="border-b border-border p-2 text-right">
                  Effect
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.factors.map((f, i) => (
                <tr key={i}>
                  <th scope="row" className="p-2 text-left font-medium break-words">
                    {f.factor}
                  </th>
                  <td className="p-2 break-words">{f.value}</td>
                  <td className="p-2 text-right">{f.n ?? "n/a"}</td>
                  <td className="p-2 text-right break-words">{f.effect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ShowDetails>

      <p data-testid="honesty-line" className="m-0 text-xs text-text-muted">
        {honestyLine(detail.beatsLuck)}
      </p>
    </main>
  );
}
