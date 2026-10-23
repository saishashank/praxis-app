// The Control Room status ring (UXN-283): nine segments (one per part), coloured healthy / needs
// attention / down, with the state also in the line pattern and in a mark beside the number, so colour
// is never the only signal (UXN-001). Each segment is a link to its readout. Server-rendered SVG.
import { n } from "@/components/charts/format";
import type { HealthComponentView } from "@/lib/ui/loaders/health";
import styles from "./ControlRoom.module.css";
import { anchorOf, nameOf, STATE_MARK, STATE_WORD } from "./ControlRoomText";

const C = 150; // threshold-ok: svg centre
const R = 105; // threshold-ok: svg ring radius
const LABEL_R = 138; // threshold-ok: svg number radius
const GAP = 5; // threshold-ok: degrees between segments

function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}
function arc(from: number, to: number): string {
  const [x1, y1] = polar(R, from);
  const [x2, y2] = polar(R, to);
  return `M${n(x1)} ${n(y1)}A${R} ${R} 0 0 1 ${n(x2)} ${n(y2)}`;
}

const STROKE: Record<string, { color: string; dash?: string }> = {
  healthy: { color: "var(--color-breaker-green)" },
  attention: { color: "var(--color-breaker-amber)", dash: "14 6" },
  down: { color: "var(--color-breaker-red)", dash: "4 5" },
};

export function ControlRoomRing({
  components,
  healthy,
  total,
}: {
  components: HealthComponentView[];
  healthy: number;
  total: number;
}) {
  const sweep = 360 / Math.max(1, components.length);
  const summary = `${healthy} / ${total} healthy. ${components
    .map((c, i) => `${i + 1}, ${nameOf(c.id)}: ${STATE_WORD[c.state] ?? c.state}`)
    .join("; ")}`;
  return (
    <div className={styles.ringWrap}>
      <svg
        className={styles.ring}
        viewBox="0 0 300 300"
        role="group"
        aria-label={`Status ring. ${summary}`}
        data-testid="status-ring"
      >
        <circle
          className={`${styles.track} ${styles.glow}`}
          cx={C}
          cy={C}
          r={82}
          pathLength={100}
          aria-hidden="true"
        />
        {components.map((c, i) => {
          const s = STROKE[c.state] ?? STROKE.attention;
          const mid = i * sweep + sweep / 2;
          const [lx, ly] = polar(LABEL_R, mid);
          const word = STATE_WORD[c.state] ?? c.state;
          return (
            <a
              key={c.id}
              href={`#${anchorOf(c.id)}`}
              className={styles.seg}
              style={{ ["--i" as string]: i }}
              data-seg={c.id}
              data-state={c.state}
              aria-label={`${i + 1}. ${nameOf(c.id)}: ${word}`}
            >
              <path
                d={arc(i * sweep + GAP / 2, (i + 1) * sweep - GAP / 2)}
                fill="none"
                stroke={s.color}
                color={s.color}
                strokeWidth={24}
                strokeDasharray={s.dash}
              />
              <text
                x={n(lx)}
                y={n(ly)}
                fontSize={13}
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--color-text)"
                fontFamily="var(--font-mono)"
              >
                {i + 1}
                {STATE_MARK[c.state] ?? ""}
              </text>
            </a>
          );
        })}
        <text
          x={C}
          y={C - 2}
          fontSize={40}
          textAnchor="middle"
          fill="var(--color-text)"
          fontFamily="var(--font-mono)"
        >
          {healthy} / {total}
        </text>
        <text x={C} y={C + 20} fontSize={14} textAnchor="middle" fill="var(--color-text-muted)">
          healthy
        </text>
      </svg>
    </div>
  );
}
