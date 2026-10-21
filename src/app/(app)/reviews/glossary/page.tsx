// Glossary (UX-071b, UXN-031, UXN-032): searchable definitions of the app's terms. Read-only for every
// role; the content is the same for everyone (no stock, price or user data), so there is nothing to
// mask. The "More" link of every term popover and the Simulated label land on an entry's anchor here.
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { textParam } from "@/lib/ui/loaders/shell";
import { searchGlossary, type GlossaryEntry } from "./entries";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function GlossaryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  await requireUser("read", "/reviews/glossary");
  const raw = typeof sp.q === "string" ? sp.q : undefined;
  const q = textParam(raw, 60);
  if (q === null) notFound();
  const entries = searchGlossary(q);
  const groups = [...new Set(entries.map((e) => e.group))];

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Glossary</h1>
        <p className="m-0 text-sm text-text-muted">
          What the words in this app mean. The friendly word is shown first and the official term
          beside it.
        </p>
      </header>

      <form
        action="/reviews/glossary"
        method="get"
        role="search"
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="gl-q" className="text-sm font-semibold">
            Search the glossary
          </label>
          <input
            id="gl-q"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            maxLength={60}
            placeholder="drawdown, CIF, stop-loss"
            className="min-h-10 w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-text"
          />
        </div>
        <button
          type="submit"
          className="min-h-10 rounded border border-border bg-surface px-4 py-2 text-sm font-semibold"
        >
          Search
        </button>
      </form>

      {entries.length === 0 ? (
        <EmptyState title="No terms match">Try a shorter or different word.</EmptyState>
      ) : (
        groups.map((g, i) => (
          <section key={g} aria-labelledby={`gl-g${i}`} className="flex min-w-0 flex-col gap-2">
            <h2 id={`gl-g${i}`} className="text-xl font-semibold">
              {g}
            </h2>
            <dl className="m-0 flex flex-col gap-3">
              {entries
                .filter((e) => e.group === g)
                .map((e) => (
                  <Entry key={e.id} e={e} />
                ))}
            </dl>
          </section>
        ))
      )}
    </main>
  );
}

function Entry({ e }: { e: GlossaryEntry }) {
  return (
    <div
      id={e.id}
      className="min-w-0 scroll-mt-24 rounded-lg border border-border bg-surface p-3 break-words"
    >
      <dt className="font-semibold">
        {e.term}
        {e.official ? (
          <span className="ml-2 text-sm font-normal text-text-muted">Official: {e.official}</span>
        ) : null}
      </dt>
      <dd className="m-0 mt-1 text-sm">{e.meaning}</dd>
    </div>
  );
}
