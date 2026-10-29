// "Pushing it up" / "Pulling it down" bars (UXN-121 style, UXR-054): one bar per closed trade, grouped by
// the sign of its return. Bars use the signed outcome colours (gain, loss), never grey, and every bar
// carries its figure in text with a glyph. Server component, pure CSS.
import { hueStyle } from "@/components/ui/hue";
import { formatPpm, gainLossGlyph } from "@/lib/view/format";

export type OutcomeItem = { key: string; stock: string; returnPpm: number };

function Group({
  title,
  hue,
  items,
  max,
}: {
  title: string;
  hue: string;
  items: OutcomeItem[];
  max: number;
}) {
  return (
    <div data-outcome-group={hue} className="min-w-0">
      <h4 className="m-0 mb-2 text-sm font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-text-muted">None so far.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((i) => (
            <li key={i.key} style={hueStyle(hue)} className="min-w-0 text-sm">
              <div className="flex min-w-0 justify-between gap-2">
                <span className="min-w-0 break-words">{i.stock}</span>
                <span className="font-mono text-[var(--h-text)]">
                  <span aria-hidden="true">{gainLossGlyph(i.returnPpm)} </span>
                  {formatPpm(i.returnPpm, { sign: "always" })}
                </span>
              </div>
              <div aria-hidden="true" className="h-2 w-full rounded bg-surface-2">
                <div
                  data-outcome-bar=""
                  className="h-2 rounded bg-[var(--h-fill)]"
                  style={{
                    width: `${Math.max(2, Math.round((Math.abs(i.returnPpm) / max) * 100))}%`,
                  }} // threshold-ok: percent
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OutcomeBars({ items }: { items: OutcomeItem[] }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.returnPpm)));
  const up = items.filter((i) => i.returnPpm > 0).sort((a, b) => b.returnPpm - a.returnPpm);
  const down = items.filter((i) => i.returnPpm < 0).sort((a, b) => a.returnPpm - b.returnPpm);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
      <Group title="Pushing it up" hue="positive" items={up} max={max} />
      <Group title="Pulling it down" hue="negative" items={down} max={max} />
    </div>
  );
}
