"use client";
// The Radix half of the news pop-up (see NewsSheet.tsx). It is loaded by a dynamic import the first time
// a headline is activated (or at once for /news?item=), so Radix Dialog is not in the first-load JS
// (UX-005 budget).
import * as Dialog from "@radix-ui/react-dialog";
import type { RefObject } from "react";
import { InfoButton } from "@/components/ui/Overlays";
import { CloseIcon } from "@/components/ui/icons";
import {
  materialityLabel,
  NO_SUMMARY,
  POLARITY_HOW,
  polarityLabel,
  SOURCE_LINE,
  whenText,
} from "./text";
import type { SheetItem } from "./NewsSheet";

const OVERLAY = "fixed inset-0 z-40 bg-black/60";
const CONTENT =
  "fixed z-50 overflow-y-auto border border-border bg-surface p-4 text-text break-words " +
  "inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl " +
  "lg:inset-y-0 lg:right-0 lg:left-auto lg:bottom-auto lg:max-h-none lg:w-96 lg:rounded-none";

function Body({ item }: { item: SheetItem }) {
  return (
    <div className="mt-2 flex flex-col gap-3 text-sm" data-testid="news-sheet-body">
      <Dialog.Description className="m-0 text-text-muted">
        {item.stock}
        {item.company ? ` · ${item.company}` : ""} · {whenText(item.published)}
        {item.type ? ` · ${item.type}` : ""}
      </Dialog.Description>
      <p className="m-0 text-text-muted">{SOURCE_LINE}</p>
      <p className="m-0" data-testid="news-sheet-summary">
        {item.assessment ?? NO_SUMMARY}
      </p>
      <div className="flex flex-wrap items-center gap-1" data-testid="news-sheet-tag">
        <span className="font-medium">{polarityLabel(item.polarity)}</span>
        <InfoButton label="How this tag was decided">
          <p className="m-0 text-sm">{POLARITY_HOW}</p>
        </InfoButton>
      </div>
      <p className="m-0 text-text-muted">
        {materialityLabel(item.materiality)}
        {item.priceSensitive ? " · Marked price-sensitive by the exchange" : ""}
      </p>
      {item.url ? (
        <p className="m-0">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            Read the original (opens in a new tab)
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** The pop-up frame. Shows the item, or a status line while it loads or if loading failed. */
export function NewsDialog({
  open,
  onOpenChange,
  triggerRef,
  title,
  item,
  failed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The headline button to return focus to; absent when the sheet opens by itself. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  title: string;
  item: SheetItem | null;
  failed: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          className={CONTENT}
          onCloseAutoFocus={
            triggerRef
              ? (event) => {
                  event.preventDefault();
                  triggerRef.current?.focus();
                }
              : undefined
          }
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
          {item ? (
            <Body item={item} />
          ) : (
            <Dialog.Description className="mt-2 text-sm text-text-muted" role="status">
              {failed ? "Could not load this item. Close and try again." : "Loading…"}
            </Dialog.Description>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
