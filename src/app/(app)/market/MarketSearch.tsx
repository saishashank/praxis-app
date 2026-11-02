"use client";
// Instant company search (UXN-270, decision 49). Works without JavaScript as a GET form that reloads
// /market?q=...; with JavaScript the results update after a 150 ms pause from GET /api/market/search.
// Masked users get a disabled box with the reason (DAT-124: matching a typed code would reveal which
// codes exist), so nothing is sent for them.
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RowActions, type WatchMode } from "./RowActions";
import type { WatchResult } from "./messages";

export type SearchHit = { code: string; name: string; sector: string | null; starred: boolean };

const DEBOUNCE_MS = 150; // threshold-ok: decision 49
const MIN_CHARS = 1; // threshold-ok: one character is enough to search

type Props = {
  initialQuery: string;
  initialHits: SearchHit[];
  masked: boolean;
  note: string | null;
  mode: WatchMode;
  starAction: (fd: FormData) => Promise<WatchResult>;
};

export function MarketSearch({ initialQuery, initialHits, masked, note, mode, starAction }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>(initialHits);
  const [asked, setAsked] = useState(initialQuery.length > 0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ctl = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      ctl.current?.abort();
    },
    [],
  );

  function search(term: string) {
    const c = new AbortController();
    ctl.current = c;
    fetch(`/api/market/search?q=${encodeURIComponent(term)}`, {
      credentials: "same-origin",
      signal: c.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { results: SearchHit[] };
      })
      .then((body) => {
        setHits(body.results);
        setAsked(true);
        setFailed(false);
      })
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      });
  }

  function onChange(value: string) {
    setQ(value);
    clearTimeout(timer.current);
    ctl.current?.abort();
    const term = value.trim();
    if (masked || term.length < MIN_CHARS) {
      setHits([]);
      setAsked(false);
      setFailed(false);
      return;
    }
    timer.current = setTimeout(() => search(term), DEBOUNCE_MS);
  }

  return (
    <section aria-labelledby="market-search-h" className="flex flex-col gap-2">
      <h2 id="market-search-h" className="m-0 text-lg font-semibold">
        Find a company
      </h2>
      <form
        action="/market"
        method="get"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          clearTimeout(timer.current);
          ctl.current?.abort();
          const term = q.trim();
          if (!masked && term.length >= MIN_CHARS) search(term);
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span>Search by company name or code</span>
          <input
            type="search"
            name="q"
            value={q}
            maxLength={40}
            autoComplete="off"
            disabled={masked}
            aria-describedby={masked ? "market-search-note" : undefined}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-8 rounded-md border border-border bg-bg px-2 py-1 text-text disabled:opacity-60"
          />
        </label>
        <button
          type="submit"
          disabled={masked}
          className="min-h-8 rounded-md border border-border bg-surface px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          Search
        </button>
      </form>
      {note ? (
        <p id="market-search-note" className="m-0 text-sm text-text-muted">
          {note} Search is switched off for you.
        </p>
      ) : null}
      <div aria-live="polite">
        {failed ? <p role="alert">Search is not available right now. Try again.</p> : null}
        {!masked && asked && !failed && hits.length === 0 ? (
          <EmptyState compact motif="market" hue="market" title="No companies match that search." />
        ) : null}
        {hits.length > 0 && !masked ? (
          <ul aria-label="Search results" className="m-0 flex list-none flex-col gap-2 p-0">
            {hits.map((h) => (
              <li
                key={h.code}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-surface p-2"
              >
                <Link
                  href={`/market/${encodeURIComponent(h.code)}`}
                  className="min-w-0 break-words"
                >
                  <span className="font-semibold">{h.name}</span>{" "}
                  <span className="font-mono text-text-muted">{h.code}</span>
                  {h.sector ? (
                    <span className="block text-xs text-text-muted">{h.sector}</span>
                  ) : null}
                </Link>
                <RowActions
                  slug={h.code}
                  stock={h.code}
                  starred={h.starred}
                  mode={mode}
                  starAction={starAction}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
