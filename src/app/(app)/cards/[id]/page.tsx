// Decision Card, read-only (AGT-110, decision 29: a minimal read-only page for review links).
// All signed-in roles may read it. The card is the stored canonical JSON (no free text); the note
// beside it is the wording stored by batch 2b (template or LLM). Nothing here writes.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { DecisionCard } from "@/lib/agents/cards";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const MAX_ID = 300; // threshold-ok: id length guard
const PPM_PER_PERCENT = 10_000; // threshold-ok: unit conversion
const MICRO_PER_UNIT = 1_000_000; // threshold-ok: unit conversion
const ppm = (v: number | null): string =>
  v === null ? "n/a" : `${(v / PPM_PER_PERCENT).toFixed(2)}%`;
const micro = (v: string | null): string =>
  v === null ? "n/a" : `A$${(Number(v) / MICRO_PER_UNIT).toFixed(2)}`;

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (id.length === 0 || id.length > MAX_ID) notFound();
  await requireUser("read", `/cards/${encodeURIComponent(id)}`);
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
  const s = card.scenario;
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Decision Card: {card.code} ({card.execution})
        </h1>
        <p className="text-sm text-text-muted">
          {card.d}, {card.family} {card.rule_version}, regime {card.regime}.{" "}
          {card.taken
            ? "Order placed."
            : `Not taken: ${card.not_taken_reason ?? "reason not recorded"}.`}
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>
      <section aria-labelledby="thesis-h" className="flex flex-col gap-2">
        <h2 id="thesis-h" className="text-xl font-semibold">
          Thesis
        </h2>
        <p>{card.thesis}</p>
        {note.rows.length > 0 && (
          <p className="text-sm text-text-muted">
            {String(note.rows[0]!.text)}{" "}
            {note.rows[0]!.provider === null ? "(Written without AI.)" : "(AI wording.)"}
          </p>
        )}
      </section>
      <section aria-labelledby="rules-h" className="flex flex-col gap-2">
        <h2 id="rules-h" className="text-xl font-semibold">
          Rules fired
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {card.rules_fired.map((x) => (
            <li key={x.rule}>
              {x.rule}: {x.value} (threshold {x.threshold}) {x.pass ? "passed" : "not met"}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="breakers-h" className="flex flex-col gap-2">
        <h2 id="breakers-h" className="text-xl font-semibold">
          Thesis-breakers
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {card.thesis_breakers.map((b) => (
            <li key={b.id}>
              {b.id}: {b.check}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="exit-h" className="flex flex-col gap-2">
        <h2 id="exit-h" className="text-xl font-semibold">
          Exit plan
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {card.exit_plan.map((x) => (
            <li key={`${x.tag}:${x.rule}`}>
              {x.tag} {x.rule} ({x.kind})
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="size-h" className="flex flex-col gap-2">
        <h2 id="size-h" className="text-xl font-semibold">
          Size and cost
        </h2>
        <p className="text-sm">
          {card.sizing.available
            ? `Quantity ${card.sizing.qty ?? "n/a"} at ${micro(card.sizing.fill_price_micro)}, order value ${micro(card.sizing.order_value_micro)}${card.sizing.half_size ? " (half size)" : ""}.`
            : "Sizing was not available."}{" "}
          {card.cost.available
            ? `Round-trip cost ${micro(card.cost.cost_estimate_micro)}, break-even ${ppm(card.cost.break_even_ppm)}.`
            : `Cost not available${card.cost.reason ? ` (${card.cost.reason})` : ""}.`}
        </p>
      </section>
      <section aria-labelledby="scenario-h" className="flex flex-col gap-2">
        <h2 id="scenario-h" className="text-xl font-semibold">
          Scenario
        </h2>
        <p className="text-sm">
          {s.insufficient_history
            ? `Insufficient history (${s.reason ?? "n/a"}).`
            : `Net return p10 ${ppm(s.p10_ppm)}, p50 ${ppm(s.p50_ppm)}, p90 ${ppm(s.p90_ppm)} (n = ${s.n}).`}
        </p>
      </section>
      <p className="text-xs text-text-muted">{card.footnote}</p>
    </main>
  );
}
