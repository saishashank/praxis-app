// Holdings (M21 B1, UXN-316, UXN-317; D-1220; F). The Owner's own holdings, typed or imported from a CSV, with what the
// app already knows about each company: thesis-breakers that are not green, the Owner's pick alerts, and the paper
// position with its stop and exit rule. Read-only beside the entry form; a holding changes no book, order, signal or
// alert. Visible only to the pinned Owner while the Owner tools are on. requireOwnerTools is the FIRST await.
import { notFound } from "next/navigation";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import { authDb, mainDb } from "@/lib/db/client";
import { brokerLinksFor } from "@/lib/ownerTools/brokerLinks";
import { loadHoldingFacts, type HoldingFacts } from "@/lib/ownerTools/holdingFacts";
import { loadCurrentHoldings, type CurrentHoldings } from "@/lib/ownerTools/holdings";
import { loadProfile } from "@/lib/market/profile";
import { ownerTools } from "@/lib/preferences/ownerTools";
import { envFor } from "@/lib/ui/loaders/shell";
import { Banner } from "@/components/ui/States";
import { Money } from "@/components/ui/Values";
import { BrokerLinks } from "@/components/ownerTools/BrokerLinks";
import { HoldingsForm, type HoldingEntry } from "@/components/ownerTools/HoldingsForm";
import { OwnerToolsNav } from "@/components/ownerTools/OwnerToolsNav";
import { saveHoldingsAction } from "./actions";

export const dynamic = "force-dynamic";

const NO_FACTS: HoldingFacts = { known: true, breakers: [], alerts: [], paper: [] };

export default async function HoldingsPage() {
  const user = await requireOwnerTools("/holdings");
  const env = await envFor(user);
  const owner = await ownerTools({ auth: authDb(), main: mainDb() }, user, process.env);
  if (owner === null) notFound(); // the guard passed a moment ago; a failed read looks like a missing route
  let current: CurrentHoldings | null = null;
  let readFailed = false;
  try {
    current = await loadCurrentHoldings(mainDb(), env.market);
  } catch {
    readFailed = true;
  }
  let facts = new Map<string, HoldingFacts>();
  try {
    facts = await loadHoldingFacts(env, current?.rows.map((r) => r.code) ?? []);
  } catch {
    facts = new Map(); // the rows still show, without the facts
  }
  let marketName: string = env.market;
  try {
    marketName = (await loadProfile(env.main, env.market)).name;
  } catch {
    // the market code stands in for its name
  }
  const entries: HoldingEntry[] = (current?.rows ?? []).map((r) => ({
    code: r.code,
    qty: String(r.qty),
    cost: costText(r.avgCostMicro),
  }));

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Holdings</h1>
        <p className="m-0 text-sm text-text-muted">
          What you hold, kept here only so the app can show what it knows about each company.
          Nothing here changes a paper book, a pick or an alert.
        </p>
        <OwnerToolsNav current="/holdings" />
      </header>

      {readFailed ? (
        <Banner tone="warning" title="Not available">
          Your holdings could not be read. Try again later.
        </Banner>
      ) : current === null ? (
        <p data-testid="holdings-empty" className="m-0 rounded-md border border-border p-3 text-sm">
          No holdings saved yet. Type them below or import a CSV file.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="holdings-list">
          {current.rows.map((r) => {
            const f = facts.get(r.code) ?? NO_FACTS;
            return (
              <li
                key={r.code}
                data-testid="holding-row"
                className="min-w-0 break-words rounded-md border border-border p-3 text-sm"
              >
                <p className="m-0 font-semibold">
                  {r.code}{" "}
                  <span className="font-normal text-text-muted">
                    · {r.qty} shares at an average of{" "}
                    <Money micro={r.avgCostMicro} currency={env.currency} />
                  </span>
                </p>
                <div className="mt-1">
                  <BrokerLinks
                    links={brokerLinksFor(owner.broker_links, { code: r.code, market: env.market })}
                  />
                </div>
                {!f.known ? (
                  <p data-testid="holding-unknown" className="m-0 mt-2">
                    Not in the {marketName} list: the app has no facts for this code.
                  </p>
                ) : (
                  <ul className="m-0 mt-2 list-none space-y-1 p-0">
                    <li data-testid="holding-breakers">
                      {f.breakers.length === 0 ? (
                        <>Thesis checks: nothing flagged.</>
                      ) : (
                        <>
                          Thesis checks:{" "}
                          {f.breakers
                            .map(
                              (b) =>
                                `${b.status === "triggered" ? "triggered" : "watch"} (${b.trigger}; ${b.value}; ${b.day})`,
                            )
                            .join(" · ")}
                        </>
                      )}
                    </li>
                    <li data-testid="holding-alerts">
                      {f.alerts.length === 0 ? (
                        <>Your pick alerts: none.</>
                      ) : (
                        <>
                          Your pick alerts:{" "}
                          {f.alerts
                            .map((a) => `${a.tier} idea of ${a.pickDate}, ${a.state}`)
                            .join(" · ")}
                        </>
                      )}
                    </li>
                    <li data-testid="holding-paper">
                      {f.paper.length === 0 ? (
                        <>Paper book: not held.</>
                      ) : (
                        f.paper.map((p) => (
                          <span key={`${p.strategy}-${p.since}`} className="block">
                            Paper book: open since {p.since}, {p.qty} shares, stop-loss in force{" "}
                            <Money micro={p.stopMicro} currency={env.currency} />. {p.strategy}:{" "}
                            {p.exitRule}
                          </span>
                        ))
                      )}
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section aria-labelledby="edit-h" className="flex flex-col gap-2">
        <h2 id="edit-h" className="m-0 text-lg font-semibold">
          Update your holdings
        </h2>
        <p className="m-0 text-sm text-text-muted">
          A save replaces the whole list with what you enter here; the earlier list is kept in the
          history of uploads.
        </p>
        <HoldingsForm action={saveHoldingsAction} current={entries} />
      </section>
    </main>
  );
}

/** Micro as a plain decimal for the edit field: "12.5", "0.0125" (no float; trailing zeros dropped). */
function costText(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole.toString()}.${frac}`;
}
