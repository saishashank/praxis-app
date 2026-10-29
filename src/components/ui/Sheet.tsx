"use client";
// Sheet / drawer (UXR-043, UXR-003): bottom sheet on phones (max 90 % height), 480 px right drawer on
// desktop, on the Radix dialog (D-164). One primary-action slot (`primary`); Esc, the close button and
// a click outside close it without saving. Without JavaScript the trigger is a plain link to `href`
// (the detail page), so a settings row still works (D-207 item 14).
//
// Two ways to use it:
//  - with `trigger` (+ optional `href`): the sheet renders its own trigger and manages its open state;
//  - controlled: pass `open` / `onOpenChange` and open it from any control (e.g. a ValueRow).
// Not the same as `Sheet` in Overlays.tsx (the older M7 filter sheet, kept for its current users).
import { lazy, Suspense, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "./cn";

const Panel = lazy(() => import("./SheetPanel").then((m) => ({ default: m.V2SheetPanel })));

export function Sheet({
  title,
  description,
  children,
  primary,
  trigger,
  href,
  triggerClassName,
  open: openProp,
  onOpenChange,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  /** The one primary action (a Save button). Closing without it never saves. */
  primary?: ReactNode;
  /** Content of the built-in trigger; omit when the sheet is controlled from outside. */
  trigger?: ReactNode;
  /** No-JS fallback: the trigger is a link to this detail page. */
  href?: string;
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : inner;
  const setOpen = (next: boolean) => {
    if (next) setMounted(true);
    if (!controlled) setInner(next);
    onOpenChange?.(next);
  };
  // A controlled sheet may be opened from outside before this component ever saw a click.
  if (open && !mounted) setMounted(true);

  const hasTrigger = trigger !== undefined;
  const cls = cn("ui-motion", triggerClassName);
  const onClick = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    setOpen(!open);
  };

  return (
    <>
      {hasTrigger && href !== undefined ? (
        <a
          href={href}
          ref={(el) => {
            ref.current = el;
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={onClick}
          className={cls}
        >
          {trigger}
        </a>
      ) : hasTrigger ? (
        <button
          type="button"
          ref={(el) => {
            ref.current = el;
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={onClick}
          className={cls}
        >
          {trigger}
        </button>
      ) : null}
      {mounted ? (
        <Suspense fallback={null}>
          <Panel
            open={open}
            onOpenChange={setOpen}
            returnFocusTo={hasTrigger ? ref : undefined}
            title={title}
            description={description}
            primary={primary}
          >
            {children}
          </Panel>
        </Suspense>
      ) : null}
    </>
  );
}
