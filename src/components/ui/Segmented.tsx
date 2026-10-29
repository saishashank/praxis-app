"use client";
// Segmented control (UXR-040, UXR-002). Equal segments, full width on phones. The selected segment has
// three cues: filled surface, check icon, and aria-selected (buttons) or aria-current plus a hidden
// "Selected" (links). Two modes: buttons (controlled, `onChange`) and links (state in the URL, items
// carry `href`).
import Link from "next/link";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon } from "./icons";

export type SegmentedItem = { value: string; label: ReactNode; href?: string };

const SEG =
  "ui-motion inline-flex min-h-11 flex-1 shrink-0 items-center justify-center gap-1 px-3 py-2 text-sm break-words";
const ON = "bg-accent text-accent-contrast font-semibold";
const OFF = "bg-surface text-text hover:bg-bg";

export function Segmented({
  label,
  items,
  value,
  onChange,
  className,
}: {
  /** Accessible name of the group. */
  label: string;
  items: SegmentedItem[];
  value: string;
  /** Button mode: called when the selection moves (click or arrow key). */
  onChange?: (value: string) => void;
  className?: string;
}) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const linkMode = items.length > 0 && items.every((i) => i.href !== undefined);
  const wrap = cn(
    "flex w-full divide-x divide-border overflow-x-auto rounded-lg border border-border sm:inline-flex sm:w-auto",
    className,
  );

  const move = (from: number, e: KeyboardEvent<HTMLElement>) => {
    const n = items.length;
    let to = from;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (from + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (from - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    else return;
    e.preventDefault();
    refs.current[to]?.focus();
    // Buttons: moving the focus moves the selection. Links: focus only (Enter follows the link).
    if (!linkMode) onChange?.(items[to].value);
  };

  if (linkMode) {
    return (
      <nav aria-label={label} className={wrap}>
        {items.map((it, i) => {
          const on = it.value === value;
          return (
            <Link
              key={it.value}
              href={it.href as string}
              ref={(el) => {
                refs.current[i] = el;
              }}
              aria-current={on ? "page" : undefined}
              onKeyDown={(e) => move(i, e)}
              className={cn(SEG, on ? ON : OFF)}
            >
              {on ? <CheckIcon aria-hidden="true" /> : null}
              {it.label}
              {on ? <span className="sr-only"> (Selected)</span> : null}
            </Link>
          );
        })}
      </nav>
    );
  }

  const selectedIndex = Math.max(
    0,
    items.findIndex((i) => i.value === value),
  );
  return (
    <div role="tablist" aria-label={label} className={wrap}>
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={i === selectedIndex ? 0 : -1}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => onChange?.(it.value)}
            onKeyDown={(e) => move(i, e)}
            className={cn(SEG, on ? ON : OFF)}
          >
            {on ? <CheckIcon aria-hidden="true" /> : null}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
