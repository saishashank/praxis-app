"use client";
// A disclosure menu for the header (gear and region). Pattern: a button with aria-expanded controls a
// panel of ordinary links and forms; Tab moves through them, Esc closes and returns focus to the
// button, a click outside or leaving focus closes it, and following a link closes it. Not role="menu":
// plain links need no arrow-key roving, so the keyboard behaviour is the browser's own.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export function MenuButton({
  label,
  children: panel,
  icon,
  text,
  className,
  panelClassName,
}: {
  /** Accessible name of the button. */
  label: string;
  /** Panel content (server-rendered links / forms). */
  children: ReactNode;
  icon: ReactNode;
  /** Optional visible text next to the icon. */
  text?: string;
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && next && root.current && !root.current.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-text hover:bg-surface-2",
          className,
        )}
      >
        {icon}
        {text ? <span className="hidden max-w-40 truncate sm:inline">{text}</span> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
          className={cn(
            "absolute right-0 top-full z-50 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-2 text-sm shadow-lg",
            panelClassName,
          )}
        >
          {panel}
        </div>
      ) : null}
    </div>
  );
}
