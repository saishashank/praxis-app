// System Health "Last 7 nights" (V1-I1, D-770): ONE table, a row per PLT-073 step (from evaluateDay)
// and per Worker route slot that failed a post (V2-I4), a column per night. Owner only; it only reads.
// A failed read shows a neutral line, never the error.
import { emailEnvName } from "@/lib/email/send";
import { mainDb } from "@/lib/db/client";
import { loadNights, type NightsTable } from "@/lib/health/routePosts";

export function NightsView({ table }: { table: NightsTable | null }) {
  return (
    <section aria-labelledby="nights-h" className="flex flex-col gap-3">
      <h2 id="nights-h" className="text-xl font-semibold">
        Last 7 nights
      </h2>
      {table === null ? (
        <p role="status" className="text-sm text-text-muted">
          The nightly history is unavailable.
        </p>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Each step against its PLT-073 deadline, oldest night first. A Worker route row appears
            only for a slot with a failed post; a dash there means no failure was recorded, not a
            confirmed run.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Step results for the last 7 nights</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Step
                  </th>
                  {table.dates.map((d) => (
                    <th key={d} scope="col" className="py-2 pr-3 font-mono text-xs">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {r.label}
                    </th>
                    {r.cells.map((c) => (
                      <td key={c.date} className="py-2 pr-3">
                        <span
                          className={
                            c.bad
                              ? "rounded border px-2 py-0.5 font-mono text-xs"
                              : "font-mono text-xs text-text-muted"
                          }
                        >
                          {c.text}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export async function NightsCheck({ owner }: { owner: boolean }) {
  if (!owner) return null;
  let table: NightsTable | null = null;
  try {
    table = await loadNights(mainDb(), new Date(), emailEnvName(process.env));
  } catch {
    table = null; // neutral message in the view; no error details
  }
  return <NightsView table={table} />;
}
