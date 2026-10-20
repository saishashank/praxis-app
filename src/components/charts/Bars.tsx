import { ChartTable } from "./ChartTable";
import { clamp, money, n, signed, tone } from "./format";

const W = 320;
const PAD = 12;

/** NAV against the seed (UX-011): stall floor, bust and target marked and labelled. */
export function GlyphBar({
  nav,
  seed = 600,
  stallFloor = 511,
  bust = 300,
  target = 1200,
  currency = "A$",
}: {
  nav: number;
  seed?: number;
  stallFloor?: number;
  bust?: number;
  target?: number;
  currency?: string;
}) {
  const max = Math.max(target, nav) * 1.05;
  const x = (v: number) => PAD + (clamp(v, 0, max) / max) * (W - 2 * PAD);
  const marks = [
    { name: "Bust", v: bust },
    { name: "Stall floor", v: stallFloor },
    { name: "Seed", v: seed },
    { name: "Target", v: target },
  ];
  const summary = `NAV ${money(nav, currency)} against seed ${money(seed, currency)}: bust ${money(bust, currency)}, stall floor ${money(stallFloor, currency)}, target ${money(target, currency)}`;
  return (
    <figure className="m-0">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${W} 64`} width="100%" height={64}>
        <rect
          x={PAD}
          y={24}
          width={W - 2 * PAD}
          height={10}
          rx={2}
          fill="none"
          stroke={tone.grid}
        />
        <rect x={PAD} y={24} width={n(x(nav) - PAD)} height={10} rx={2} fill={tone.c1} />
        {marks.map((m, i) => (
          <g key={m.name}>
            <line
              x1={n(x(m.v))}
              x2={n(x(m.v))}
              y1={18}
              y2={40}
              stroke={tone.text}
              strokeWidth={2}
            />
            <text
              x={n(x(m.v))}
              y={i % 2 === 0 ? 12 : 54}
              fontSize={10}
              textAnchor="middle"
              fill={tone.text}
            >
              {m.name} {money(m.v, currency)}
            </text>
          </g>
        ))}
      </svg>
      <ChartTable
        caption="NAV and thresholds"
        headers={["Level", "Value"]}
        rows={[["NAV", money(nav, currency)], ...marks.map((m) => [m.name, money(m.v, currency)])]}
      />
    </figure>
  );
}

export type BustState = "safe" | "near" | "busted";

/** Distance to bust (UXN-150): three states, each with a text label and a different pattern, not colour only. */
export function BustBar({
  nav,
  seed = 600,
  bust = 300,
  nearPct = 15,
  currency = "A$",
}: {
  nav: number;
  seed?: number;
  bust?: number;
  nearPct?: number;
  currency?: string;
}) {
  const room = (nav - bust) / (seed - bust);
  const state: BustState = nav <= bust ? "busted" : room * 100 <= nearPct ? "near" : "safe";
  const stateText = { safe: "Safe", near: "Near bust", busted: "Busted" }[state];
  const fill = { safe: tone.c4, near: tone.c3, busted: tone.text }[state];
  const pct = clamp(room, 0, 1);
  const summary = `Distance to bust: ${stateText}. NAV ${money(nav, currency)}, bust ${money(bust, currency)}, ${n(pct * 100)}% of the way from bust to seed`;
  return (
    <figure className="m-0">
      <svg role="img" aria-label={summary} viewBox="0 0 200 28" width="100%" height={28}>
        <defs>
          <pattern id="bust-hatch" width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M0 6L6 0" stroke={tone.surface} strokeWidth={2} />
          </pattern>
        </defs>
        <rect x={2} y={4} width={196} height={10} rx={2} fill="none" stroke={tone.grid} />
        <rect x={2} y={4} width={n(196 * pct)} height={10} rx={2} fill={fill} />
        {state !== "safe" && (
          <rect x={2} y={4} width={n(196 * pct)} height={10} rx={2} fill="url(#bust-hatch)" />
        )}
        <text x={2} y={26} fontSize={10} fill={tone.text}>
          {stateText}
        </text>
      </svg>
      <ChartTable
        caption="Distance to bust"
        headers={["Measure", "Value"]}
        rows={[
          ["State", stateText],
          ["NAV", money(nav, currency)],
          ["Bust level", money(bust, currency)],
        ]}
      />
    </figure>
  );
}

export type HBarItem = { label: string; value: number };

/** Horizontal bars around zero (factor contributions, concentration); sign + arrow in each label. */
export function HBar({
  items,
  label,
  unit = "%",
}: {
  items: HBarItem[];
  label: string;
  unit?: string;
}) {
  const maxAbs = Math.max(1e-9, ...items.map((i) => Math.abs(i.value)));
  const rowH = 22;
  const labelW = 110;
  const mid = labelW + (W - labelW - 60) / 2;
  const half = (W - labelW - 60) / 2;
  const summary = `${label}: ${items.map((i) => `${i.label} ${signed(i.value, 1, unit)}`).join(", ")}`;
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${W} ${Math.max(1, items.length) * rowH}`}
        width="100%"
        height={Math.max(1, items.length) * rowH}
      >
        <line x1={n(mid)} x2={n(mid)} y1={0} y2={items.length * rowH} stroke={tone.grid} />
        {items.map((it, i) => {
          const w = (Math.abs(it.value) / maxAbs) * half;
          const x = it.value >= 0 ? mid : mid - w;
          return (
            <g key={it.label}>
              <text x={0} y={i * rowH + 15} fontSize={11} fill={tone.text}>
                {it.label.length > 16 ? `${it.label.slice(0, 15)}…` : it.label}
              </text>
              <rect
                x={n(x)}
                y={i * rowH + 4}
                width={n(w)}
                height={14}
                fill={it.value >= 0 ? tone.c1 : tone.c3}
              />
              <text x={W - 56} y={i * rowH + 15} fontSize={11} fill={tone.text}>
                {signed(it.value, 1, unit)}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartTable
        caption={label}
        headers={["Item", "Value"]}
        rows={items.map((i) => [i.label, signed(i.value, 1, unit)])}
      />
    </figure>
  );
}
