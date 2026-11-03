"use client";
// The Decision Card popup (D-884). A native <dialog> opened with showModal(): the browser traps the
// focus, Esc closes it, and the page behind is inert. Closing (the button, Esc or a click on the
// backdrop) goes back in history, which leaves the page that opened the card exactly as it was.
// A slot keeps its last page on a soft navigation, so the popup draws nothing once the address is no
// longer a card (a link inside the card to another page leaves no dialog behind).
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

export function CardModal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const router = useRouter();
  const onCard = (usePathname() ?? "").startsWith("/cards/");
  useEffect(() => {
    const d = ref.current;
    if (onCard && d && !d.open) d.showModal();
  }, [onCard]);
  if (!onCard) return null;
  return (
    <dialog
      ref={ref}
      aria-label="Decision Card"
      onClose={() => router.back()}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
      className="ui-card-modal m-auto max-h-[92vh] w-[min(56rem,96vw)] overflow-y-auto rounded-xl border border-border bg-bg p-0 text-text backdrop:bg-black/50"
    >
      <div className="sticky top-0 z-40 flex justify-end border-b border-border bg-bg/95 px-3 py-2">
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="min-h-11 rounded-md border border-border px-4 text-sm"
        >
          Close
        </button>
      </div>
      <div className="flex min-w-0 flex-col gap-6 px-4 py-4">{children}</div>
    </dialog>
  );
}
