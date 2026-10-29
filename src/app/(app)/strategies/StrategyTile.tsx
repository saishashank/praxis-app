// One strategy tile of the Strategies list (UX-011, UXN-039, UXN-052, UXN-057, UXN-060, UXN-104).
// Server component. The short name and money type with the one-liner beneath are always visible; the
// "About" popover carries the four hover lines. Every figure is simulated and says so through the page's
// Simulated label; a missing figure says "Not measured yet" (never a sparkline of nothing).
import Link from "next/link";
import { Sparkline } from "@/components/charts/Sparkline";
import { FamilyBadge } from "@/components/ui/Family";
import { BAND_BG, hueStyle } from "@/components/ui/hue";
import { InfoButton } from "@/components/ui/Overlays";
import { Pill } from "@/components/ui/Pill";
import { BreakerStatus, RegimeBadge, ValidationBadge } from "@/components/ui/Badges";
import { GainLoss, Money, NotMeasured } from "@/components/ui/Values";
import type { StrategyTile as Tile } from "@/lib/ui/loaders/strategies";
import type { StrategyName } from "@/lib/ui/loaders/common";
import type { TileExtra } from "@/lib/ui/loaders/strategyViews";
import { formatDate } from "@/lib/view/format";
import { familyBadge } from "../home/familyMap";
import { NavBar } from "./NavBar";
import { tileState } from "./state";

const MICRO_PER_CENT = 10_000; // threshold-ok: micro-AUD to cents
const cents = (micro: number | undefined): number | undefined =>
  micro === undefined ? undefined : Math.round(micro / MICRO_PER_CENT);

export function StrategyTile({
  tile,
  name,
  extra,
  reasons,
}: {
  tile: Tile;
  name: StrategyName | undefined;
  extra: TileExtra | undefined;
  /** Plain-words attention reasons (only inside the "Needs attention" group). */
  reasons?: string[];
}) {
  const hid = `tile-${tile.execution}`;
  const fam = familyBadge(tile.family);
  const state = tileState(tile);
  const sparkValues = tile.spark.map((m) => Math.round(m / MICRO_PER_CENT) / 100);
  return (
    <article
      aria-labelledby={hid}
      data-strategy-tile=""
      data-hue={`family-${fam.code}`}
      style={hueStyle(`family-${fam.code}`)}
      className="flex min-w-0 flex-col gap-3 overflow-hidden break-words rounded-lg border border-l-4 border-border border-l-[var(--h-fill)] bg-surface pb-4"
    >
      <div
        style={{ background: BAND_BG }}
        className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-2"
      >
        <FamilyBadge code={fam.code} label={fam.label} />
        {state ? <Pill kind="state" value={state} /> : <Pill kind="status" value="neutral" />}
      </div>
      <header className="min-w-0 px-4">
        <div className="flex items-start justify-between gap-2">
          <h3 id={hid} className="m-0 min-w-0 text-base font-semibold">
            <Link
              href={`/strategies/${encodeURIComponent(tile.execution)}`}
              className="text-accent underline"
            >
              {tile.name}
            </Link>
          </h3>
          {name ? (
            <InfoButton label={`About ${tile.name}`}>
              <p className="m-0 text-xs text-text-muted">Strategy</p>
              <p className="m-0 font-semibold">{name.name}</p>
              <dl className="m-0 mt-2 space-y-1">
                <div>
                  <dt className="font-semibold">How it buys</dt>
                  <dd className="m-0">{name.buys}</dd>
                </div>
                <div>
                  <dt className="font-semibold">How it sells</dt>
                  <dd className="m-0">{name.sells}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Works best when</dt>
                  <dd className="m-0">{name.works_best}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Main risk</dt>
                  <dd className="m-0">{name.main_risk}</dd>
                </div>
              </dl>
            </InfoButton>
          ) : null}
        </div>
        <p className="m-0 text-sm text-text-muted">{tile.moneyType}</p>
        {tile.oneLiner ? <p className="m-0 mt-1 text-sm">{tile.oneLiner}</p> : null}
      </header>

      {reasons && reasons.length > 0 ? (
        <ul className="m-0 mx-4 list-disc space-y-1 pl-5 text-sm">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      {tile.hasCohort ? (
        <>
          <p className="m-0 px-4 text-sm text-text-muted">
            Round {tile.round} · started {formatDate(tile.startD)} · {tile.sessions}{" "}
            {tile.sessions === 1 ? "session" : "sessions"} held
          </p>
          <NavBar
            label={tile.name}
            navCents={cents(tile.nav?.micro) ?? null}
            startCents={cents(tile.seed?.micro)}
            minCents={cents(tile.bust?.micro)}
            maxCents={cents(tile.target?.micro)}
            className="px-4"
          />
          <dl className="m-0 mx-4 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-muted">Value now</dt>
            <dd className="m-0 text-right">
              <Money micro={tile.nav?.micro ?? null} />
            </dd>
            <dt className="text-text-muted">Change since start</dt>
            <dd className="m-0 text-right">
              <GainLoss value={tile.returnPpm} kind="ppm" />
            </dd>
            <dt className="text-text-muted">Open positions</dt>
            <dd className="m-0 text-right font-mono">{extra?.openPositions ?? <NotMeasured />}</dd>
            {extra?.sleeve ? (
              <>
                <dt className="text-text-muted">Leverage sleeve</dt>
                <dd className="m-0 text-right">
                  {extra.sleeve === "locked" ? "Locked" : "Unlocked"}
                </dd>
              </>
            ) : null}
          </dl>
          {sparkValues.length >= 2 ? (
            <div className="px-4">
              <Sparkline
                values={sparkValues}
                label={`${tile.name} value, last ${sparkValues.length} sessions`}
              />
            </div>
          ) : (
            <p className="m-0 px-4 text-sm">
              Last 30 sessions: <NotMeasured />
            </p>
          )}
        </>
      ) : (
        <p className="m-0 px-4 text-sm">
          <NotMeasured>No round has started yet</NotMeasured>
        </p>
      )}

      <div className="flex flex-wrap items-start gap-2 px-4">
        <RegimeBadge regime={tile.regime} />
        {tile.label ? (
          <ValidationBadge label={tile.label} />
        ) : (
          <NotMeasured>No evidence label yet</NotMeasured>
        )}
        {extra?.breaker ? <BreakerStatus status={extra.breaker} /> : null}
      </div>
    </article>
  );
}
