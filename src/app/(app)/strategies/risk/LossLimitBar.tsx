// Distance to the loss limit (UXN-150), in plain words (Owner 2026-11-10: no "bust", no "NAV"): three
// states, each with a text label and a different pattern, not colour only. The shared BustBar keeps its
// own wording for the charts gallery; this Risk page version says what an ordinary reader would.
import { ChartTable } from "@/components/charts/ChartTable";
import { currencyFormatFor } from "@/lib/view/format";
import { clamp, money, n, tone } from "@/components/charts/format";

type LimitState = "safe" | "near" | "hit";

const STATE_TEXT: Record<LimitState, string> = {
  safe: "Comfortable",
  near: "Close to the loss limit",
  hit: "Hit the loss limit",
};

export function LossLimitBar({
  nav,
  seed,
  bust,
  nearPct,
  currency,
}: {
  nav: number;
  seed: number;
  bust: number;
  nearPct: number;
  /** ISO 4217 code (D-1002). */
  currency: string;
}) {
  const fmt = currencyFormatFor(currency);
  const room = (nav - bust) / (seed - bust);
  const state: LimitState = nav <= bust ? "hit" : room * 100 <= nearPct ? "near" : "safe";
  const stateText = STATE_TEXT[state];
  const fill = { safe: tone.c4, near: tone.c3, hit: tone.text }[state];
  const pct = clamp(room, 0, 1);
  const summary = `Distance to the loss limit: ${stateText}. Value ${money(nav, fmt)}, loss limit ${money(bust, fmt)}, ${n(pct * 100)}% of the way from the loss limit to the start`;
  return (
    <figure className="m-0">
      <svg role="img" aria-label={summary} viewBox="0 0 200 28" width="100%" height={28}>
        <defs>
          <pattern id="limit-hatch" width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M0 6L6 0" stroke={tone.surface} strokeWidth={2} />
          </pattern>
        </defs>
        <rect x={2} y={4} width={196} height={10} rx={2} fill="none" stroke={tone.grid} />
        <rect x={2} y={4} width={n(196 * pct)} height={10} rx={2} fill={fill} />
        {state !== "safe" && (
          <rect x={2} y={4} width={n(196 * pct)} height={10} rx={2} fill="url(#limit-hatch)" />
        )}
        <text x={2} y={26} fontSize={10} fill={tone.text}>
          {stateText}
        </text>
      </svg>
      <ChartTable
        caption="Distance to the loss limit"
        headers={["Measure", "Value"]}
        rows={[
          ["State", stateText],
          ["Value", money(nav, fmt)],
          ["Loss limit", money(bust, fmt)],
        ]}
      />
    </figure>
  );
}
