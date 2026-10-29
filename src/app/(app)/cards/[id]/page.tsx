// Decision Card = "Why this trade" (UX-041, UX-042, AGT-110/111; UXN-037, 100, 102, 104, 120 to 123,
// 126; docs/M7_design.md 3 row 16; D-128, D-129, D-135 draft). All signed-in roles read it. The page
// renders only the view model of src/lib/ui/loaders/cards.ts, which resolves the address with
// `resolveCardRef` and masks everything on the server (DAT-124, ROL-107, UX-009): a masked user is
// addressed by an opaque `ck:` reference, sees "Stock A" and no price, amount, exact date, company
// name or link, and a real card id gives the same "not found" as an unknown one. Every text is a
// fixed template filled from stored numbers: no LLM, no probability, no "will" (UXN-102, VAL-101).
// Owner and Editor can add a note; nothing here places an order (UX-042).
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RegimeBadge, ValidationBadge } from "@/components/ui/Badges";
import { Card } from "@/components/ui/Card";
import { FamilyBadge, Rail } from "@/components/ui/Family";
import { Pill } from "@/components/ui/Pill";
import { ShowDetails, Banner } from "@/components/ui/States";
import { SimulatedLabel } from "@/components/ui/Values";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import {
  FACTOR_CAPTION,
  SCENARIO_SENTENCE,
  WHY_LABEL,
  type FactorItem,
} from "@/lib/ui/loaders/cardParts";
import { loadCardPage } from "@/lib/ui/loaders/cards";
import { NOT_ADVICE_FOOTER, SCENARIO_CAPTION } from "@/lib/view/honesty";
import { familyBadge } from "../../home/familyMap";
import { addCardNoteAction } from "./actions";
import { NoteForm } from "./NoteForm";
import { Steelman } from "./Steelman";

export const dynamic = "force-dynamic";

function FactorList({ title, items }: { title: string; items: FactorItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0 text-sm">
        {items.map((f, i) => (
          <li key={`${i}:${f.label}`} className="min-w-0 break-words">
            <div>
              {f.effect === null ? (
                <span className="font-mono">not enough history</span>
              ) : (
                <span className="font-mono">
                  <span aria-hidden="true">{(f.effectPpm ?? 0) > 0 ? "▲" : "▼"} </span>
                  {f.effect}
                </span>
              )}{" "}
              {f.label} (today {f.today}, {f.n} past trades)
            </div>
            {f.effect !== null ? (
              <div
                aria-hidden="true"
                className="mt-1 h-2 rounded bg-chart-1"
                style={{ width: `${f.barPct}%` }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = "";
  }
  const user = await requireUser("read", `/cards/${encodeURIComponent(id)}`);
  if (id.length === 0) notFound();
  const page = await loadCardPage({ mainDb: mainDb(), authDb: authDb(), user }, id);
  const c = page.data;
  const v = c.view;
  if (!page.data.found || v === null) notFound();
  const masked = page.masked;
  const canNote = can(user.role, "annotate");

  const fam = familyBadge(c.family ?? "");
  const state = c.taken ? "Order placed" : "Not taken";

  return (
    <main className="mx-auto flex max-w-3xl min-w-0 flex-col gap-6 px-4 py-6">
      {/* Sticky bar on phones (UXR-024): the code (already masked by the loader) and the state. */}
      <div
        data-testid="card-sticky"
        className="sticky top-14 z-30 -mx-4 flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2 text-sm sm:hidden"
      >
        <span className="min-w-0 font-semibold break-words">{v.stock}</span>
        <span className="shrink-0 text-text-muted">{state}</span>
      </div>

      <Rail
        hue={`family-${fam.code}`}
        header={
          <div className="flex flex-wrap items-center gap-2">
            <FamilyBadge code={fam.code} label={fam.label} />
            <ValidationBadge label={c.validation} />
            <RegimeBadge regime={c.regime} />
          </div>
        }
      >
        <header className="flex min-w-0 flex-col gap-2">
          <h1 className="m-0 text-2xl font-semibold tracking-tight break-words">{v.title}</h1>
          <p className="m-0 text-sm text-text-muted break-words">{v.subtitle}</p>
          <p className="m-0 text-xs text-text-muted">{NOT_ADVICE_FOOTER}</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link href={c.links.home} className="text-accent underline">
              Home
            </Link>
            <Link href="/strategies/ideas" className="text-accent underline">
              Tonight&apos;s trade ideas
            </Link>
            {c.links.strategy ? (
              <Link href={c.links.strategy} className="text-accent underline">
                This strategy
              </Link>
            ) : null}
          </div>
        </header>
      </Rail>

      <Card title="What and why" data-testid="card-what-why">
        <p className="m-0">{v.thesis}</p>
        {v.note ? (
          <p className="mt-2 mb-0 text-sm text-text-muted">
            {v.note.text} {v.note.wording}
          </p>
        ) : null}
      </Card>

      <Card title="Rules that fired">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="p-1 font-semibold">
                  Rule
                </th>
                <th scope="col" className="p-1 font-semibold">
                  Result
                </th>
                <th scope="col" className="p-1 font-semibold">
                  Value
                </th>
                <th scope="col" className="p-1 font-semibold">
                  Needed
                </th>
                <th scope="col" className="p-1 font-semibold">
                  Margin
                </th>
              </tr>
            </thead>
            <tbody>
              {c.checklist.map((r, i) => (
                <tr key={`${i}:${r.label}`} className="border-b border-border last:border-0">
                  <td className="p-1 break-words">{r.label}</td>
                  <td className="p-1">
                    <span aria-hidden="true">{r.pass ? "✓ " : "✗ "}</span>
                    {r.pass ? "Met" : "Not met"}
                    {r.justMet ? <strong> (only just met)</strong> : null}
                  </td>
                  <td className="p-1 font-mono">{r.value}</td>
                  <td className="p-1">{r.needed ?? "—"}</td>
                  <td className="p-1">{r.margin ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3">
          <ShowDetails summary="Show the exact rule values">
            <ul className="m-0 list-disc pl-5 text-sm text-text-muted">
              {v.rules.map((x, i) => (
                <li key={`${i}:${x}`}>{x}</li>
              ))}
            </ul>
          </ShowDetails>
        </div>
      </Card>

      <Card title="Thesis-breakers">
        {c.breakers.length > 0 ? (
          <ul className="m-0 mb-3 flex list-none flex-col gap-2 p-0 text-sm">
            {c.breakers.map((b, i) => (
              <li key={`${i}:${b.id}`} className="flex min-w-0 flex-wrap items-center gap-2">
                <Pill kind="thesis" value={b.status} />
                <span className="break-words">
                  {b.id}: {b.value}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mb-3 text-sm text-text-muted">Not checked yet.</p>
        )}
        <ul className="m-0 list-disc pl-5 text-sm">
          {v.breakers.map((x, i) => (
            <li key={`${i}:${x}`}>{x}</li>
          ))}
        </ul>
      </Card>

      <Card title="Exit plan">
        <ul className="m-0 list-disc pl-5 text-sm">
          {v.exits.map((x, i) => (
            <li key={`${i}:${x}`}>{x}</li>
          ))}
        </ul>
        <h3 className="mt-4 mb-1 text-sm font-semibold">Size and cost</h3>
        <p className="m-0 text-sm">{v.sizing}</p>
        <p className="mt-2 mb-0">
          <SimulatedLabel />
        </p>
      </Card>

      <Card title="Scenario">
        {c.scenarioRows === null ? (
          <p className="m-0 text-sm">{v.scenario}</p>
        ) : (
          <>
            <p className="m-0 mb-2 text-sm">{SCENARIO_CAPTION}</p>
            <table className="w-full table-fixed border-collapse text-sm">
              <caption className="sr-only">{SCENARIO_CAPTION}</caption>
              <thead>
                <tr>
                  {c.scenarioRows.map((r) => (
                    <th key={r.label} scope="col" title={r.percentile} className="p-1 text-left">
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {c.scenarioRows.map((r) => (
                    <td key={r.label} className="p-1 font-mono">
                      {r.value}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="mt-2 mb-0 text-xs text-text-muted">{SCENARIO_SENTENCE}</p>
          </>
        )}
      </Card>

      <Steelman data={c.steelman} />

      <Card title="Evidence" data-testid="card-evidence">
        <div className="flex flex-col gap-5">
          <div>
            <h3 className="m-0 text-sm font-semibold">Based on</h3>
            <ol className="mt-2 mb-0 flex list-decimal flex-col gap-1 pl-5 text-sm">
              {c.basedOn.map((b, i) => (
                <li key={`${i}:${b.text}`}>
                  {b.text}
                  {b.newsId ? (
                    <>
                      {" "}
                      <Link
                        href={`/news?item=${encodeURIComponent(b.newsId)}`}
                        className="text-accent underline"
                      >
                        news
                      </Link>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
            <p className="mt-3 mb-0 text-sm">{c.evidenceLine}</p>
          </div>

          {c.past ? (
            <div className="flex flex-col gap-1 text-sm">
              <h3 className="m-0 text-sm font-semibold">What past similar setups did</h3>
              <p className="m-0">{c.past.summary}</p>
              {c.past.lines.map((l) => (
                <p key={l} className="m-0">
                  {l}
                </p>
              ))}
              {c.past.caveat ? <p className="m-0 text-text-muted">{c.past.caveat}</p> : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <h3 className="m-0 text-sm font-semibold">What pushes it up and what pulls it down</h3>
            {c.factors === null ? (
              <p className="m-0 text-sm text-text-muted">
                Not enough history to say yet: the factor figures are built weekly from past trades.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <FactorList title="Pushing it up" items={c.factors.up} />
                <FactorList title="Pulling it down" items={c.factors.down} />
                <FactorList title="Not enough history" items={c.factors.notEnough} />
              </div>
            )}
            <p className="m-0 text-xs text-text-muted">{FACTOR_CAPTION}</p>
          </div>

          <div>
            <h3 className="m-0 text-sm font-semibold">What could hurt this</h3>
            <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0 text-sm">
              {c.headwinds.map((h, i) => (
                <li key={`${i}:${h.text}`} className="min-w-0 break-words">
                  <strong>{h.kind}:</strong> {h.text}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="m-0 text-sm font-semibold">Why?</h3>
            <div className="mt-2">
              <ShowDetails summary="Show the reasons in words">
                <p className="m-0 mb-2 text-xs font-semibold">{WHY_LABEL}</p>
                <ul className="m-0 list-disc pl-5 text-sm">
                  {c.why.map((l, i) => (
                    <li key={`${i}:${l}`}>{l}</li>
                  ))}
                </ul>
              </ShowDetails>
            </div>
          </div>
        </div>
      </Card>

      {c.afterwards ? (
        <Card title="Afterwards: how did it turn out?">
          <p className="m-0 text-sm">{c.afterwards.text}</p>
        </Card>
      ) : null}

      <Card title="Notes">
        {c.notes.length === 0 ? (
          <EmptyState compact motif="list" hue="home" title="No notes yet." />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {c.notes.map((n) => (
              <li key={n.id} className="min-w-0 break-words">
                {n.text === null ? (
                  <>
                    Note added by {n.role} on {n.day}
                  </>
                ) : (
                  <>
                    {n.text}{" "}
                    <span className="text-text-muted">
                      ({n.role}, {n.day})
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {canNote ? <NoteForm cardRef={id} action={addCardNoteAction} /> : null}
        {masked && canNote ? (
          <div className="mt-2">
            <Banner tone="info">
              Your access hides stock names, so other people with the same access see only that a
              note was added.
            </Banner>
          </div>
        ) : null}
      </Card>

      <p className="m-0 text-xs text-text-muted">{v.footnote}</p>
    </main>
  );
}
