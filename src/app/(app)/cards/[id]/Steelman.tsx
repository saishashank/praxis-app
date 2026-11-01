// Steelman section of the Decision Card (V2 ch. 07, UXR-024; M11-lite D-497/D-498): the strongest case
// for and against the card, written by a model from the evidence on the card and checked app-side. Two
// lists with evidence chips, the cited evidence rows, and a caption that says what it is. Under 640 px the
// body sits in a collapsed <details> (no client state): the two bodies are the same markup with their own
// id prefix, one shown per breakpoint by CSS. Nothing here is advice or a forecast.
import { Card } from "@/components/ui/Card";
import type { SteelmanView } from "@/lib/steelman/read";

const CAPTION = "AI-written from the evidence on this card. Not advice; not a forecast.";

const REASON_TEXT: Record<string, string> = {
  daily_limit: "the daily limit of written cases was reached",
  budget: "the daily model allowance was used up",
  no_model: "no model was available",
  critic_unavailable: "no independent checker was available",
  rejected: "the answer did not pass the checks",
};

function Side({
  title,
  points,
  prefix,
}: {
  title: string;
  points: SteelmanView["bull"];
  prefix: string;
}) {
  return (
    <section className="min-w-0" aria-label={title}>
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0 text-sm">
        {points.map((p, i) => (
          <li key={i} className="min-w-0">
            <p className="m-0">{p.text}</p>
            <p className="m-0 mt-1 flex flex-wrap gap-1">
              {p.citations.map((c) => (
                <a
                  key={c}
                  href={`#${prefix}${c}`}
                  className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-accent underline"
                >
                  {c}
                </a>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Body({ data, prefix }: { data: SteelmanView; prefix: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <Side title="Strongest case for" points={data.bull} prefix={prefix} />
        <Side title="Strongest case against" points={data.bear} prefix={prefix} />
      </div>
      {data.cited.length > 0 && (
        <section className="min-w-0" aria-label="Evidence cited">
          <h3 className="m-0 text-sm font-semibold">Evidence cited</h3>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm text-text-muted">
            {data.cited.map((e) => (
              <li key={e.id} id={`${prefix}${e.id}`} className="min-w-0 scroll-mt-16">
                <span className="font-medium text-text">{e.id}</span> {e.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function Steelman({ data }: { data: SteelmanView | null }) {
  if (data === null) return null;
  if (data.state === "not_written") {
    const why = data.reason ? REASON_TEXT[data.reason] : undefined;
    return (
      <Card title="Strongest case for and against" data-testid="steelman">
        <p className="m-0 text-sm text-text-muted">Not available tonight{why ? `: ${why}` : ""}.</p>
      </Card>
    );
  }
  if (data.bull.length === 0 && data.bear.length === 0) return null;
  return (
    <Card title="Strongest case for and against" data-testid="steelman">
      <p className="m-0 mb-3 text-xs text-text-muted">{CAPTION}</p>
      <div className="hidden sm:block" data-testid="steelman-wide">
        <Body data={data} prefix="ev-" />
      </div>
      <details className="sm:hidden" data-testid="steelman-narrow">
        <summary className="inline-flex min-h-6 cursor-pointer items-center py-1 text-accent underline">
          Show the case for and against
        </summary>
        <div className="mt-2">
          <Body data={data} prefix="m-ev-" />
        </div>
      </details>
    </Card>
  );
}
