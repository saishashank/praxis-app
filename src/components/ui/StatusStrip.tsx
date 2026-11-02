// Status strip (UXR-044, UXR-053): one row of items, label over value, no boxes; wraps to two rows on
// phones. With `mood` the background is the soft market-mood gradient and the mood word is printed on
// it first: the gradient is decoration, the word carries the meaning.
import type { ReactNode } from "react";
import { cn } from "./cn";

export type Mood = "on" | "neutral" | "off";

const MOOD_BG: Record<Mood, string> = {
  on: "var(--gradient-mood-on)",
  neutral: "var(--gradient-mood-neutral)",
  off: "var(--gradient-mood-off)",
};

export type StatusItem = { label: string; value: ReactNode };

export function StatusStrip({
  label,
  items,
  mood,
  className,
}: {
  /** Accessible name of the strip. */
  label: string;
  items: StatusItem[];
  /** Market mood: gradient key and the word shown on it (e.g. "Risk-on"). */
  mood?: { key: Mood; word: string };
  className?: string;
}) {
  return (
    <section
      aria-label={label}
      data-mood={mood?.key}
      style={mood ? { background: MOOD_BG[mood.key] } : undefined}
      className={cn(
        "flex flex-wrap items-start gap-x-6 gap-y-3 rounded-lg px-3 py-3 text-sm",
        mood ? "" : "border-b border-border",
        className,
      )}
    >
      {mood ? (
        <div className="min-w-0 basis-full sm:basis-auto">
          <div className="text-xs text-text-muted">Market mood</div>
          <div className="text-base font-semibold text-text">{mood.word}</div>
        </div>
      ) : null}
      {items.map((it) => (
        <div key={it.label} className="min-w-0 basis-[calc(50%-0.75rem)] sm:basis-auto">
          <div className="text-xs text-text-muted">{it.label}</div>
          <div className="font-semibold break-words text-text">{it.value}</div>
        </div>
      ))}
    </section>
  );
}
