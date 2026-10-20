"use client";
// The Radix half of the overlay islands (see Overlays.tsx). This module is only ever loaded through a
// dynamic import, after the visitor first activates a trigger, so Radix Dialog and Popover are not part of
// any route's first-load JavaScript (UX-005 budget). The trigger buttons live in Overlays.tsx and stay the
// same DOM element, so focus return and the accessible names do not change.
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import type { ReactNode, RefObject } from "react";
import { Button, buttonClass } from "./Button";
import { cn } from "./cn";
import { CloseIcon } from "./icons";

const POPOVER_CLASS =
  "z-50 max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-3 text-sm text-text shadow-lg break-words";
const OVERLAY = "fixed inset-0 z-40 bg-black/60";

type PanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** Id of the content element; the trigger points at it with aria-controls. */
  contentId: string;
  children: ReactNode;
};

/** Return focus to the trigger on close, as Radix's own Trigger does. */
function returnFocus(triggerRef: RefObject<HTMLButtonElement | null>, event: Event) {
  event.preventDefault();
  triggerRef.current?.focus();
}

export function PopoverPanel({ open, onOpenChange, triggerRef, contentId, children }: PanelProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={triggerRef as RefObject<HTMLButtonElement>} />
      <Popover.Portal>
        <Popover.Content
          id={contentId}
          sideOffset={6}
          collisionPadding={16}
          className={POPOVER_CLASS}
          onCloseAutoFocus={(event) => returnFocus(triggerRef, event)}
          onInteractOutside={(event) => {
            // The trigger toggles the popover itself; do not also dismiss it.
            if (triggerRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SheetPanel({
  open,
  onOpenChange,
  triggerRef,
  contentId,
  title,
  description,
  children,
}: PanelProps & { title: string; description: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          id={contentId}
          onCloseAutoFocus={(event) => returnFocus(triggerRef, event)}
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

export function ConfirmPanel({
  open,
  onOpenChange,
  triggerRef,
  contentId,
  title,
  description,
  confirmLabel,
  action,
  danger,
  children,
}: PanelProps & {
  title: string;
  description: string;
  confirmLabel: string;
  action: (formData: FormData) => void | Promise<void>;
  danger: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          id={contentId}
          onCloseAutoFocus={(event) => returnFocus(triggerRef, event)}
          className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-4 text-text break-words"
        >
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
