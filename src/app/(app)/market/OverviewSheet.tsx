"use client";
// The "i" company overview (UXN-272, decision 48): a side sheet on desktop and a bottom sheet on
// phones, filled from GET /api/market/[code]/overview (facts only until the summary writer is live).
// Radix Dialog supplies Esc to close, the focus trap and focus return to the "i" button. The row it
// sits in links to the company page, which is the no-JavaScript fallback.
import type { Swot } from "@/lib/view/swot";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { formatCount, formatMicro, formatPpm } from "@/lib/view/format";

type Overview = {
  masked: boolean;
  stock: string;
  slug: string;
  name: string | null;
  sector: string | null;
  d: string | null;
  close: { micro: string } | null;
  changePpm: number | null;
  volume: number | null;
  announcements: Array<{ id: number; title: string; published: string; url: string | null }>;
  summary: string;
  notice: string;
  /** D-196: the rules-based SWOT, null with too little history. */
  swot: Swot | null;
};
type Load = { state: "loading" } | { state: "error" } | { state: "ok"; data: Overview };

function Body({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/market/${encodeURIComponent(slug)}/overview`, {
      credentials: "same-origin",
      signal: ctl.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as Overview;
      })
      .then((data) => setLoad({ state: "ok", data }))
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setLoad({ state: "error" });
      });
    return () => ctl.abort();
  }, [slug]);

  if (load.state === "loading") return <p role="status">Loading overview…</p>;
  if (load.state === "error") {
    return <p role="alert">The overview could not be loaded. Close this and try again.</p>;
  }
  const o = load.data;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section aria-labelledby={`ov-snap-${slug}`}>
        <h3 id={`ov-snap-${slug}`} className="m-0 text-base font-semibold">
          Snapshot
        </h3>
        <dl className="m-0 mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          {o.name ? (
            <>
              <dt className="text-text-muted">Company</dt>
              <dd className="m-0 break-words">{o.name}</dd>
            </>
          ) : null}
          {o.sector ? (
            <>
              <dt className="text-text-muted">Sector</dt>
              <dd className="m-0 break-words">{o.sector}</dd>
            </>
          ) : null}
          {o.close ? (
            <>
              <dt className="text-text-muted">End-of-day price{o.d ? ` (${o.d})` : ""}</dt>
              <dd className="m-0 font-mono">{formatMicro(o.close.micro)}</dd>
            </>
          ) : null}
          <dt className="text-text-muted">Day change</dt>
          <dd className="m-0 font-mono">
            {o.changePpm === null ? "n/a" : formatPpm(o.changePpm, { sign: "always" })}
          </dd>
          <dt className="text-text-muted">Volume</dt>
          <dd className="m-0 font-mono">{formatCount(o.volume)}</dd>
        </dl>
      </section>
      <section aria-labelledby={`ov-sum-${slug}`}>
        <h3 id={`ov-sum-${slug}`} className="m-0 text-base font-semibold">
          What the company does and SWOT
        </h3>
        <p className="m-0 mt-1 text-text-muted">{o.summary}</p>
        {o.swot ? (
          <div className="mt-2 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2" data-swot="">
            {(
              [
                ["Strengths", o.swot.strengths],
                ["Weaknesses", o.swot.weaknesses],
                ["Opportunities", o.swot.opportunities],
                ["Threats", o.swot.threats],
              ] as const
            ).map(([title, lines]) => (
              <div key={title} className="min-w-0 rounded-lg border border-border p-2">
                <h4 className="m-0 text-sm font-semibold">{title}</h4>
                {lines.length === 0 ? (
                  <p className="m-0 mt-1 text-sm text-text-muted">Nothing stands out.</p>
                ) : (
                  <ul className="m-0 mt-1 list-disc space-y-1 pl-4 text-sm">
                    {lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 mt-1 text-sm text-text-muted">
            A SWOT needs about a year of price history for this company.
          </p>
        )}
        <p className="m-0 mt-2 text-xs text-text-muted">{o.notice}</p>
      </section>
      <section aria-labelledby={`ov-news-${slug}`}>
        <h3 id={`ov-news-${slug}`} className="m-0 text-base font-semibold">
          Recent announcements
        </h3>
        {o.announcements.length === 0 ? (
          <p className="m-0 mt-1 text-text-muted">No announcements stored yet.</p>
        ) : (
          <ul className="m-0 mt-1 list-none space-y-2 p-0">
            {o.announcements.map((a) => (
              <li key={a.id} className="min-w-0 break-words">
                {a.url ? (
                  <a href={a.url} rel="noopener noreferrer" target="_blank" className="underline">
                    {a.title}
                  </a>
                ) : (
                  a.title
                )}
                <span className="block text-xs text-text-muted">{a.published}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="m-0">
        <a href={`/market/${encodeURIComponent(o.slug)}`} className="text-accent underline">
          Open the company page
        </a>
      </p>
    </div>
  );
}

export function OverviewSheet({ slug, label }: { slug: string; label: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        aria-label={`Company overview for ${label}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface p-0 text-accent hover:bg-bg"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width={18}
          height={18}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-xl border border-border bg-surface p-4 text-text break-words lg:inset-y-0 lg:right-0 lg:left-auto lg:bottom-auto lg:max-h-none lg:w-96 lg:rounded-none">
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="m-0 text-lg font-semibold">Overview: {label}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-8 items-center justify-center bg-transparent p-0 text-text"
            >
              <span aria-hidden="true">×</span>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Facts from stored data. Not financial advice.
          </Dialog.Description>
          <div className="mt-3">
            <Body slug={slug} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
