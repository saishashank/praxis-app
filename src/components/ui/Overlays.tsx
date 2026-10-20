"use client";
// Client islands on the two Radix packages (shadcn pattern, D-128): Term and InfoButton (Popover),
// Sheet and ConfirmDialog (Dialog). Radix supplies Esc to close, a focus trap in dialogs, and focus
// return to the trigger. The glossary link is a plain anchor so it works without client JS.
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { Button, buttonClass, type ButtonVariant } from "./Button";
import { cn } from "./cn";
import { CloseIcon, InfoIcon } from "./icons";

const POPOVER_WORDS_MAX = 40; // threshold-ok: UXN-032 limit on a term popover

/** Cut popover text to the UXN-032 word limit so a long definition cannot push the page around. */
export function limitWords(text: string, max = POPOVER_WORDS_MAX): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

const POPOVER_CLASS =
  "z-50 max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-3 text-sm text-text shadow-lg break-words";

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
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline min-h-6 cursor-help bg-transparent p-0 text-inherit underline decoration-dotted underline-offset-2"
        >
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} collisionPadding={16} className={POPOVER_CLASS}>
          {official ? (
            <p className="m-0 mb-1 text-xs text-text-muted">Official term: {official}</p>
          ) : null}
          <p className="m-0">{limitWords(meaning)}</p>
          <a href={moreHref} className="mt-2 inline-block text-accent underline">
            More
          </a>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The "i" button: a popover with a short explanation. */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-6 items-center justify-center rounded-full bg-transparent p-0 text-accent"
        >
          <InfoIcon />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} collisionPadding={16} className={POPOVER_CLASS}>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const OVERLAY = "fixed inset-0 z-40 bg-black/60";

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
  return (
    <Dialog.Root>
      <Dialog.Trigger className={buttonClass(triggerVariant)}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          className={cn(
            "fixed z-50 overflow-y-auto border border-border bg-surface p-4 text-text break-words",
            "inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl",
            "lg:inset-y-0 lg:right-0 lg:left-auto lg:bottom-auto lg:max-h-none lg:w-96 lg:rounded-none",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="m-0 text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-6 items-center justify-center bg-transparent p-0 text-text"
            >
              <CloseIcon />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {description}
          </Dialog.Description>
          <div className="mt-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  return (
    <Dialog.Root>
      <Dialog.Trigger className={buttonClass(danger ? "danger" : "secondary")}>
        {trigger}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-4 text-text break-words">
          <Dialog.Title className="m-0 text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {description}
          </Dialog.Description>
          <form action={action} className="mt-4 flex flex-wrap justify-end gap-2">
            {children}
            <Dialog.Close className={buttonClass("secondary")}>Cancel</Dialog.Close>
            <Button type="submit" variant={danger ? "danger" : "default"}>
              {confirmLabel}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
