"use client";
// The one shared news pop-up (UXN-038): headline, source and time, our summary, the rule-based tag with
// "how we decided", a link to the original, a close button. Bottom sheet on phones, side sheet on
// desktop. Radix Dialog supplies Esc to close, the focus trap and focus return. `NewsItemButton`
// fetches `GET /api/news/[id]` (masked server-side, D-136); `NewsAutoSheet` shows an item the page
// already loaded for `/news?item=<ann_id>` and returns to the list URL on close.
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { InfoButton } from "@/components/ui/Overlays";
import { CloseIcon } from "@/components/ui/icons";
import {
  materialityLabel,
  NO_SUMMARY,
  POLARITY_HOW,
  polarityLabel,
  SOURCE_LINE,
  whenText,
  type Polarity,
} from "./text";

export type SheetItem = {
  id: number;
  stock: string;
  company: string | null;
  title: string;
  type: string | null;
  published: string;
  priceSensitive: boolean;
  materiality: number | null;
  polarity: Polarity;
  assessment: string | null;
  url: string | null;
};

const OVERLAY = "fixed inset-0 z-40 bg-black/60";
const CONTENT =
  "fixed z-50 overflow-y-auto border border-border bg-surface p-4 text-text break-words " +
  "inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl " +
  "lg:inset-y-0 lg:right-0 lg:left-auto lg:bottom-auto lg:max-h-none lg:w-96 lg:rounded-none";

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className={OVERLAY} />
      <Dialog.Content className={CONTENT}>
        <div className="flex items-start justify-between gap-2">
          <Dialog.Title className="m-0 text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            className="inline-flex size-6 items-center justify-center bg-transparent p-0 text-text"
          >
            <CloseIcon />
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

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

/** A headline that opens the pop-up. The item is fetched when it opens. */
export function NewsItemButton({ id, headline }: { id: number; headline: string }) {
  const [item, setItem] = useState<SheetItem | null>(null);
  const [failed, setFailed] = useState(false);

  const load = async () => {
    setFailed(false);
    try {
      const r = await fetch(`/api/news/${id}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("not ok");
      setItem((await r.json()) as SheetItem);
    } catch {
      setFailed(true);
    }
  };

  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (open && item === null) void load();
      }}
    >
      <Dialog.Trigger className="min-h-6 bg-transparent p-0 text-left font-medium text-accent underline">
        {headline}
      </Dialog.Trigger>
      <Frame title={item?.title ?? headline}>
        {item ? (
          <Body item={item} />
        ) : (
          <Dialog.Description className="mt-2 text-sm text-text-muted" role="status">
            {failed ? "Could not load this item. Close and try again." : "Loading…"}
          </Dialog.Description>
        )}
      </Frame>
    </Dialog.Root>
  );
}

/** Opens at once with an item the server already loaded; closing returns to `closeHref`. */
export function NewsAutoSheet({ item, closeHref }: { item: SheetItem; closeHref: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) router.replace(closeHref, { scroll: false });
      }}
    >
      <Frame title={item.title}>
        <Body item={item} />
      </Frame>
    </Dialog.Root>
  );
}
