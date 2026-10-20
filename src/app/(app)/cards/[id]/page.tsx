// Decision Card, read-only (AGT-110, decision 29: a minimal read-only page for review links).
// All signed-in roles may read it, but the page renders only the view model of @/lib/view/cards,
// which masks the stock code, company names, prices, amounts and exact dates for every user without
// the Owner role or a live unmask grant (DAT-124, ROL-107, UX-009; D-128). The card is the stored
// canonical JSON (no free text); the note beside it is the wording stored by batch 2b (template or
// LLM). Nothing here writes.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { DecisionCard } from "@/lib/agents/cards";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { activeCodesForDate } from "@/lib/view/active";
import { cardViewModel } from "@/lib/view/cards";
import { EMPTY_LOOKUP, loadMaskLookup, maskContextFor, StockAliases } from "@/lib/view/mask";

export const dynamic = "force-dynamic";

const MAX_ID = 300; // threshold-ok: id length guard

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (id.length === 0 || id.length > MAX_ID) notFound();
  const user = await requireUser("read", `/cards/${encodeURIComponent(id)}`);
  const db = mainDb();
  const r = await db.execute({
    sql: "SELECT card_json FROM decision_card WHERE id = ?",
    args: [id],
  });
  if (r.rows.length === 0) notFound();
  const card = JSON.parse(String(r.rows[0]!.card_json)) as DecisionCard;
  const note = await db.execute({
    sql: "SELECT text, provider FROM card_note WHERE card_id = ? AND kind = 'summary'",
    args: [id],
  });
  // Masking decision and active set are made on the server before anything is rendered.
  const ctx = await maskContextFor(user, authDb());
  let aliases = new StockAliases([card.code]);
  let lookup = EMPTY_LOOKUP;
  if (ctx.masked) {
    const active = await activeCodesForDate(db, card.market, card.d);
    aliases = new StockAliases([...active, card.code]);
    lookup = await loadMaskLookup(db, card.market);
  }
  const v = cardViewModel(
    card,
    note.rows.length > 0
      ? {
          text: String(note.rows[0]!.text),
          provider: note.rows[0]!.provider === null ? null : String(note.rows[0]!.provider),
        }
      : null,
    ctx,
    aliases,
    lookup,
  );
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{v.title}</h1>
        <p className="text-sm text-text-muted">{v.subtitle}</p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>
      <section aria-labelledby="thesis-h" className="flex flex-col gap-2">
        <h2 id="thesis-h" className="text-xl font-semibold">
          Thesis
        </h2>
        <p>{v.thesis}</p>
        {v.note && (
          <p className="text-sm text-text-muted">
            {v.note.text} {v.note.wording}
          </p>
        )}
      </section>
      <section aria-labelledby="rules-h" className="flex flex-col gap-2">
        <h2 id="rules-h" className="text-xl font-semibold">
          Rules fired
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {v.rules.map((x, i) => (
            <li key={`${i}:${x}`}>{x}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="breakers-h" className="flex flex-col gap-2">
        <h2 id="breakers-h" className="text-xl font-semibold">
          Thesis-breakers
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {v.breakers.map((x, i) => (
            <li key={`${i}:${x}`}>{x}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="exit-h" className="flex flex-col gap-2">
        <h2 id="exit-h" className="text-xl font-semibold">
          Exit plan
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {v.exits.map((x, i) => (
            <li key={`${i}:${x}`}>{x}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="size-h" className="flex flex-col gap-2">
        <h2 id="size-h" className="text-xl font-semibold">
          Size and cost
        </h2>
        <p className="text-sm">{v.sizing}</p>
      </section>
      <section aria-labelledby="scenario-h" className="flex flex-col gap-2">
        <h2 id="scenario-h" className="text-xl font-semibold">
          Scenario
        </h2>
        <p className="text-sm">{v.scenario}</p>
      </section>
      <p className="text-xs text-text-muted">{v.footnote}</p>
    </main>
  );
}
