// Trade log (M21 B2, ARN-121, D-1221, D-1275 to D-1277). The Owner's own record of real trades, typed or imported from a
// CSV, set beside the paper picks: the matching pick, the paper fill, slippage against it, realised against paper and a
// monthly "Paper vs real" table. Display only: a trade changes no book, order, signal or alert, and there is no broker
// connection. Visible only to the pinned Owner while the Owner tools are on. requireOwnerTools is the FIRST await.
import { notFound } from "next/navigation";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import { authDb, mainDb } from "@/lib/db/client";
import { pctFromPpm, type Paper, type TradeRowView } from "@/lib/ownerTools/tradeLog/match";
import { loadTradeLog, type TradeLogModel } from "@/lib/ownerTools/tradeLog/store";
import { ownerTools } from "@/lib/preferences/ownerTools";
import { formatDay } from "@/lib/view/format";
import { envFor } from "@/lib/ui/loaders/shell";
import { Banner } from "@/components/ui/States";
import { Money } from "@/components/ui/Values";
import { OwnerToolsNav } from "@/components/ownerTools/OwnerToolsNav";
import { RemoveTradeForm } from "@/components/ownerTools/RemoveTradeForm";
import { TradesForm } from "@/components/ownerTools/TradesForm";
import { addTradesAction, voidTradeAction } from "./actions";

export const dynamic = "force-dynamic";

function paperText(p: Paper, side: "buy" | "sell", currency: string, now: Date) {
  switch (p.kind) {
    case "none":
      return <>No matching idea</>;
    case "not_bought":
      return <>Not bought on paper</>;
    case "no_exit":
      return <>The paper trade has not closed yet</>;
    case "ok":
      return (
        <>
          Paper {side === "buy" ? "fill" : "exit"}{" "}
          <Money micro={p.paperMicro} currency={currency} /> on {formatDay(p.paperD, now)}
        </>
      );
  }
}

export default async function TradesPage() {
  const user = await requireOwnerTools("/trades");
  const env = await envFor(user);
  const owner = await ownerTools({ auth: authDb(), main: mainDb() }, user, process.env);
  if (owner === null) notFound(); // the guard passed a moment ago; a failed read looks like a missing route
  let model: TradeLogModel | null = null;
  try {
    model = await loadTradeLog(mainDb(), env.market);
  } catch {
    model = null;
  }
  const byId = new Map<number, TradeRowView>((model?.view.rows ?? []).map((r) => [r.trade.id, r]));

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Trade log</h1>
        <p className="m-0 text-sm text-text-muted">
          The trades you made yourself, typed in or imported, set beside the paper ideas. Nothing
          here changes a paper book, an idea or an alert, and nothing is sent to a broker.
        </p>
        <OwnerToolsNav current="/trades" />
      </header>

      {model === null ? (
        <Banner tone="warning" title="Not available">
          Your trade log could not be read. Try again later.
        </Banner>
      ) : (
        <>
          {model.truncated ? (
            <Banner tone="warning" title="Only part of the log is shown">
              The log is longer than the page can read; the figures cover its first 5,000 trades.
            </Banner>
          ) : null}

          <section aria-labelledby="months-h" className="flex flex-col gap-2">
            <h2 id="months-h" className="m-0 text-lg font-semibold">
              Paper vs real
            </h2>
            {model.view.months.length === 0 ? (
              <p data-testid="months-empty" className="m-0 text-sm">
                Nothing to compare yet. Add a trade below.
              </p>
            ) : (
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Table (scrolls sideways)"
              >
                <table
                  data-testid="months-table"
                  className="w-full min-w-[32rem] text-left text-sm"
                >
                  <caption className="sr-only">
                    Your trades against the paper ideas, by month
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="py-1 pr-3">
                        Month
                      </th>
                      <th scope="col" className="py-1 pr-3">
                        Trades compared
                      </th>
                      <th scope="col" className="py-1 pr-3">
                        Average slippage
                      </th>
                      <th scope="col" className="py-1 pr-3">
                        Closed trades
                      </th>
                      <th scope="col" className="py-1 pr-3">
                        Your result
                      </th>
                      <th scope="col" className="py-1">
                        Paper result
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.view.months.map((m) => (
                      <tr key={m.month} data-testid="month-row">
                        <th scope="row" className="py-1 pr-3 font-medium">
                          {m.month}
                        </th>
                        <td className="py-1 pr-3">{m.compared}</td>
                        <td className="py-1 pr-3">
                          {m.meanSlippagePpm === null
                            ? "No paper price"
                            : pctFromPpm(m.meanSlippagePpm)}
                        </td>
                        <td className="py-1 pr-3">{m.roundTrips}</td>
                        <td className="py-1 pr-3">
                          {m.roundTrips === 0 ? (
                            "—"
                          ) : (
                            <Money micro={m.realNetMicro} currency={env.currency} sign="always" />
                          )}
                        </td>
                        <td className="py-1">
                          {m.roundTrips === 0 ? (
                            "—"
                          ) : (
                            <Money micro={m.paperNetMicro} currency={env.currency} sign="always" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="m-0 text-xs text-text-muted">
              Slippage is your price against the paper price, as a percentage of the paper price: a
              plus on a purchase means you paid more. An idea counts as the source of a purchase
              when it is for the same company, was published before the trade and the trade was
              within {model.maxSessions} sessions of it. Results are after fees; the paper result
              uses the idea&apos;s own return on the same cost.
            </p>
          </section>

          <section aria-labelledby="log-h" className="flex flex-col gap-2">
            <h2 id="log-h" className="m-0 text-lg font-semibold">
              Your trades
            </h2>
            {model.listed.length === 0 ? (
              <p
                data-testid="trades-empty"
                className="m-0 rounded-md border border-border p-3 text-sm"
              >
                No trades yet. Add one below or import a CSV file.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="trades-list">
                {model.listed.map((t) => {
                  const v = byId.get(t.id);
                  const removed = t.voidReason !== null;
                  return (
                    <li
                      key={t.id}
                      data-testid={removed ? "trade-removed" : "trade-row"}
                      className="min-w-0 rounded-md border border-border p-3 text-sm break-words"
                    >
                      <p className="m-0 font-semibold">
                        {t.side === "buy" ? "Bought" : "Sold"} {t.code}{" "}
                        <span className="font-normal text-text-muted">
                          · {formatDay(t.d, env.now)} · {t.qty.toString()} shares at{" "}
                          <Money micro={t.priceMicro} currency={env.currency} />, fees{" "}
                          <Money micro={t.feesMicro} currency={env.currency} />
                        </span>
                      </p>
                      {t.note !== null ? <p className="m-0 mt-1">{t.note}</p> : null}
                      {removed ? (
                        <p className="m-0 mt-1 text-text-muted">Removed: {t.voidReason}</p>
                      ) : v === undefined ? null : (
                        <ul className="m-0 mt-2 list-none space-y-1 p-0">
                          <li data-testid="trade-paper">
                            {paperText(v.paper, t.side, env.currency, env.now)}
                          </li>
                          {v.slippagePpm !== null ? (
                            <li data-testid="trade-slippage">
                              Against paper: {pctFromPpm(v.slippagePpm)}
                            </li>
                          ) : null}
                          {v.unmatchedQty > 0n ? (
                            <li data-testid="trade-unmatched">
                              {v.unmatchedQty.toString()} shares sold have no earlier purchase in
                              your log, so no result is shown for them.
                            </li>
                          ) : null}
                          {v.realNetMicro !== null ? (
                            <li data-testid="trade-result">
                              Your result{" "}
                              <Money micro={v.realNetMicro} currency={env.currency} sign="always" />
                              {v.paperNetMicro !== null ? (
                                <>
                                  {" "}
                                  against paper{" "}
                                  <Money
                                    micro={v.paperNetMicro}
                                    currency={env.currency}
                                    sign="always"
                                  />
                                </>
                              ) : null}
                            </li>
                          ) : null}
                        </ul>
                      )}
                      {removed ? null : <RemoveTradeForm action={voidTradeAction} tradeId={t.id} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      <section aria-labelledby="add-h" className="flex flex-col gap-2">
        <h2 id="add-h" className="m-0 text-lg font-semibold">
          Add trades
        </h2>
        <p className="m-0 text-sm text-text-muted">
          A trade is never edited. If one is wrong, remove it with a reason and add it again.
        </p>
        <TradesForm action={addTradesAction} market={env.market} />
      </section>
    </main>
  );
}
