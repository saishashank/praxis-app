"use client";
// Client islands on the two Radix packages (shadcn pattern, D-128): Term and InfoButton (Popover),
// Sheet and ConfirmDialog (Dialog). Radix supplies Esc to close, a focus trap in dialogs, and focus
// return to the trigger. The glossary link is a plain anchor so it works without client JS.
//
// Bundle budget (UX-005): the trigger button is rendered here with the same attributes Radix gives its
// Trigger, and the Radix part (OverlayPanels.tsx) is loaded by a dynamic import the first time the
// trigger is activated. So Radix Dialog and Popover cost no first-load JavaScript on any route, and the
// trigger stays one DOM element for its whole life (focus returns to it on close).
import { lazy, Suspense, useId, useRef, useState, type ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "./Button";
import { InfoIcon } from "./icons";

const PopoverPanel = lazy(() =>
  import("./OverlayPanels").then((m) => ({ default: m.PopoverPanel })),
);
const SheetPanel = lazy(() => import("./OverlayPanels").then((m) => ({ default: m.SheetPanel })));
const ConfirmPanel = lazy(() =>
  import("./OverlayPanels").then((m) => ({ default: m.ConfirmPanel })),
);

const POPOVER_WORDS_MAX = 40; // threshold-ok: UXN-032 limit on a term popover

/** Cut popover text to the UXN-032 word limit so a long definition cannot push the page around. */
export function limitWords(text: string, max = POPOVER_WORDS_MAX): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/** Open state plus "has been opened once" (the panel is mounted from then on and kept for focus return). */
function useDisclosure(): {
  open: boolean;
  mounted: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  contentId: string;
  triggerProps: {
    type: "button";
    "aria-haspopup": "dialog";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    "data-state": "open" | "closed";
    onClick: () => void;
  };
} {
  const [open, setOpenState] = useState(false);
  const [mounted, setMounted] = useState(false);
  const contentId = useId();
  const setOpen = (next: boolean) => {
    if (next) setMounted(true);
    setOpenState(next);
  };
  const toggle = () => setOpen(!open);
  return {
    open,
    mounted,
    setOpen,
    toggle,
    contentId,
    triggerProps: {
      type: "button",
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      "aria-controls": open ? contentId : undefined,
      "data-state": open ? "open" : "closed",
      onClick: toggle,
    },
  };
}

export function Term({
  children,
  meaning,
  official,
  moreHref = "/reviews/glossary",
}: {
  /** The friendly word as shown in the text. */
  children: ReactNode;
  meaning: string;
  /** The official term, kept in the popover (UXN-031). */
  official?: string;
  moreHref?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const d = useDisclosure();
  return (
    <>
      <button
        {...d.triggerProps}
        ref={ref}
        className="inline min-h-6 cursor-help bg-transparent p-0 text-inherit underline decoration-dotted underline-offset-2"
      >
        {children}
      </button>
      {d.mounted ? (
        <Suspense fallback={null}>
          <PopoverPanel
            open={d.open}
            onOpenChange={d.setOpen}
            triggerRef={ref}
            contentId={d.contentId}
          >
            {official ? (
              <p className="m-0 mb-1 text-xs text-text-muted">Official term: {official}</p>
            ) : null}
            <p className="m-0">{limitWords(meaning)}</p>
            <a href={moreHref} className="mt-2 inline-block text-accent underline">
              More
            </a>
          </PopoverPanel>
        </Suspense>
      ) : null}
    </>
  );
}

/** The "i" button: a popover with a short explanation. */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const d = useDisclosure();
  return (
    <>
      <button
        {...d.triggerProps}
        ref={ref}
        aria-label={label}
        className="inline-flex size-6 items-center justify-center rounded-full bg-transparent p-0 text-accent"
      >
        <InfoIcon />
      </button>
      {d.mounted ? (
        <Suspense fallback={null}>
          <PopoverPanel
            open={d.open}
            onOpenChange={d.setOpen}
            triggerRef={ref}
            contentId={d.contentId}
          >
            {children}
          </PopoverPanel>
        </Suspense>
      ) : null}
    </>
  );
}

/** Side sheet on desktop (lg and up), bottom sheet on phones. */
export function Sheet({
  trigger,
  title,
  description,
  children,
  triggerVariant = "secondary",
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
  triggerVariant?: ButtonVariant;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const d = useDisclosure();
  return (
    <>
      <button {...d.triggerProps} ref={ref} className={buttonClass(triggerVariant)}>
        {trigger}
      </button>
      {d.mounted ? (
        <Suspense fallback={null}>
          <SheetPanel
            open={d.open}
            onOpenChange={d.setOpen}
            triggerRef={ref}
            contentId={d.contentId}
            title={title}
            description={description}
          >
            {children}
          </SheetPanel>
        </Suspense>
      ) : null}
    </>
  );
}

/** Confirmation before an irreversible action. `action` is a server action used as the form action. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  action,
  danger = false,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  action: (formData: FormData) => void | Promise<void>;
  danger?: boolean;
  /** Hidden inputs the action needs. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const d = useDisclosure();
  return (
    <>
      <button
        {...d.triggerProps}
        ref={ref}
        className={buttonClass(danger ? "danger" : "secondary")}
      >
        {trigger}
      </button>
      {d.mounted ? (
        <Suspense fallback={null}>
          <ConfirmPanel
            open={d.open}
            onOpenChange={d.setOpen}
            triggerRef={ref}
            contentId={d.contentId}
            title={title}
            description={description}
            confirmLabel={confirmLabel}
            action={action}
            danger={danger}
          >
            {children}
          </ConfirmPanel>
        </Suspense>
      ) : null}
    </>
  );
}
