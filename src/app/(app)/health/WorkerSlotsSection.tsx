// System Health "Worker slots" block (M8 T11, decision 32, D-155). Owner only: the page renders it
// for the Owner and nothing else. A plain server component; the form is a client component.
import { ALWAYS_ON_SLOTS, GO_LIVE_SLOTS, type SlotsView } from "@/lib/golive/slots";
import { WorkerSlotsForm } from "./WorkerSlotsForm";
import { setSlotsEnabledAction } from "./slotsActions";

export function WorkerSlotsSection({ view }: { view: SlotsView | null }) {
  return (
    <section aria-labelledby="worker-slots-h" className="flex flex-col gap-3">
      <h2 id="worker-slots-h" className="text-xl font-semibold">
        Worker slots
      </h2>
      <p className="text-sm text-text-muted">
        Only you can change this. Each go-live slot below runs only while it is ticked in the saved
        list. Backup, maintenance and the daily import ({ALWAYS_ON_SLOTS.join(", ")}) always run,
        whatever the list says. Nothing in the list runs unless nightly dispatch is also on.
      </p>
      {view === null ? (
        <p className="text-sm text-text-muted">The slot list is unavailable.</p>
      ) : (
        <>
          <p role="status" className="text-sm">
            {view.malformed
              ? "The saved list cannot be read, so the Worker starts nothing new. Save a new list to fix it."
              : view.listed === null
                ? "No list is saved yet: every go-live slot is off."
                : `Saved list: ${view.listed.length === 0 ? "empty (every go-live slot is off)" : view.listed.join(", ")}.`}
          </p>
          <WorkerSlotsForm
            action={setSlotsEnabledAction}
            slots={GO_LIVE_SLOTS.map((s) => ({ ...s }))}
            initial={view.listed ?? []}
            alwaysOn={ALWAYS_ON_SLOTS}
          />
        </>
      )}
    </section>
  );
}
