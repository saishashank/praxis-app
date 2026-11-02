"use client";
// The Radix half of the V2 Sheet (see Sheet.tsx); only loaded by a dynamic import after the first open,
// so Radix Dialog stays out of first-load JavaScript (UX-005).
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode, RefObject } from "react";
import { cn } from "./cn";
import { CloseIcon } from "./icons";

export function V2SheetPanel({
  open,
  onOpenChange,
  returnFocusTo,
  title,
  description,
  primary,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  title: string;
  description?: string;
  primary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (returnFocusTo?.current) {
              event.preventDefault();
              returnFocusTo.current.focus();
            }
          }}
          className={cn(
            "ui-sheet fixed z-50 flex flex-col border border-border bg-surface text-text break-words",
            // Phones: bottom sheet, at most 90 % of the height (UXR-043).
            "inset-x-0 bottom-0 max-h-[90vh] rounded-t-xl",
            // Desktop: 480 px drawer on the right.
            "lg:inset-y-0 lg:right-0 lg:bottom-auto lg:left-auto lg:max-h-none lg:w-[480px] lg:rounded-none",
          )}
        >
          <div className="flex items-start justify-between gap-2 p-4 pb-2">
            <Dialog.Title className="m-0 text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-6 items-center justify-center bg-transparent p-0 text-text"
            >
              <CloseIcon />
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="m-0 px-4 text-sm text-text-muted">
              {description}
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          {primary ? (
            <div className="flex justify-end gap-2 border-t border-border p-4">{primary}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
