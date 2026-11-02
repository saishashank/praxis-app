// What-if (UX-119, ROL-102a; M7 T19b; docs/M7_design.md 3 row 29, decision 54; D-148 draft). Owner and
// Editor. Parameter what-ifs run only against the tables the nightly batch already stored (cost
// profile re-cost, uniform price shocks): at most `what_if_daily_limit_per_user` a day per user. The
// page reads and the action looks up; nothing is computed or written to trading tables, and anything
// heavier is "not available in this version". Strategy-level figures only, so no stock code appears.
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import type { WhatIfOptions } from "@/lib/whatif/options";
import { budgetFor, loadOptions, type Budget } from "@/lib/whatif/service";
import { runWhatIfAction } from "./actions";
import { WhatIfForm } from "./WhatIfForm";

export const dynamic = "force-dynamic";

export default async function WhatIfPage() {
  const user = await requireUser("what_if", "/what-if");
  let options: WhatIfOptions | null = null;
  let budget: Budget | null = null;
  try {
    [options, budget] = await Promise.all([
      loadOptions(mainDb()),
      budgetFor(mainDb(), authDb(), user.id, new Date()),
    ]);
  } catch {
    options = null; // neutral message below; no error details
  }

  return (
    <main className="mx-auto flex max-w-3xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">What-if</h1>
        <p className="m-0 text-sm text-text-muted">
          Ask how a practice strategy would look under different trading costs, or if every share it
          holds moved by the same percentage. Answers come from the results worked out each night
          and are simulated money. Nothing here changes a strategy.
        </p>
      </header>
      {options === null || budget === null ? (
        <p role="status">What-if unavailable. Nothing was changed.</p>
      ) : options.strategies.length === 0 ? (
        <EmptyState motif="strategies" hue="strategies" title="No strategies are running yet">
          What-ifs answer from nightly results, which exist once the strategies start.
        </EmptyState>
      ) : (
        <Card title="Ask a what-if">
          <WhatIfForm
            options={options}
            remaining={budget.remaining}
            limit={budget.limit}
            action={runWhatIfAction}
          />
        </Card>
      )}
    </main>
  );
}
