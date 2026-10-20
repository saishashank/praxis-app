"use client";
// The one shared news pop-up (UXN-038): headline, source and time, our summary, the rule-based tag with
// "how we decided", a link to the original, a close button. Bottom sheet on phones, side sheet on
// desktop. Radix Dialog supplies Esc to close, the focus trap and focus return. `NewsItemButton`
// fetches `GET /api/news/[id]` (masked server-side, D-136); `NewsAutoSheet` shows an item the page
// already loaded for `/news?item=<ann_id>` and returns to the list URL on close.
import { useRouter } from "next/navigation";
import { lazy, Suspense, useRef, useState } from "react";
import type { Polarity } from "./text";

const NewsDialog = lazy(() => import("./NewsSheetPanel").then((m) => ({ default: m.NewsDialog })));

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

/** A headline that opens the pop-up. The item is fetched when it opens. */
export function NewsItemButton({ id, headline }: { id: number; headline: string }) {
  const [item, setItem] = useState<SheetItem | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);

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

  const change = (next: boolean) => {
    if (next) {
      setMounted(true);
      if (item === null) void load();
    }
    setOpen(next);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={open ? "open" : "closed"}
        onClick={() => change(!open)}
        className="min-h-6 bg-transparent p-0 text-left font-medium text-accent underline"
      >
        {headline}
      </button>
      {mounted ? (
        <Suspense fallback={null}>
          <NewsDialog
            open={open}
            onOpenChange={change}
            triggerRef={ref}
            title={item?.title ?? headline}
            item={item}
            failed={failed}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** Opens at once with an item the server already loaded; closing returns to `closeHref`. */
export function NewsAutoSheet({ item, closeHref }: { item: SheetItem; closeHref: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  return (
    <Suspense fallback={null}>
      <NewsDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) router.replace(closeHref, { scroll: false });
        }}
        title={item.title}
        item={item}
        failed={false}
      />
    </Suspense>
  );
}
