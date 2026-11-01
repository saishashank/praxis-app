// Go-live sign-off (M8 T11; docs/M8_design.md section 7 phase P6, decisions 24, 33, 34). Owner only.
// Shows the go-live checklist as tick boxes, the sign-off history and what is still needed before
// production can be switched to full mode. The sign-off never switches the mode: afterwards the
// Owner sets AU to full in the System Health data controls, which then passes the interlock.
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { readEmailSwitch } from "@/lib/email/switch";
import { formatMelbourne } from "@/lib/health/format";
import {
  GO_LIVE_ITEMS,
  V2_GO_LIVE_STEPS,
  V2_GUIDE_PATH,
  V2_PHASE_LABELS,
  GO_LIVE_MARKET,
  SIGNOFF_CONFIRM_PHRASE,
  SIGNOFF_NOTE_MAX,
} from "@/lib/golive/checklist";
import { isProductionEnv } from "@/lib/golive/interlock";
import { MONEY_APPROVAL_PHRASE } from "@/lib/golive/moneyApproval";
import { readMoneyApproval, type MoneyApproval } from "@/lib/golive/moneyApprovalRead";
import { moneyConstants, moneyValueHashes } from "@/lib/golive/moneyConstants";
import { deployedCommit, loadSignoffs, type SignoffRow } from "@/lib/golive/signoff";
import { marketDate } from "@/lib/data/calendar";
import { userPreferences } from "@/lib/preferences/read";
import { approveMoneyConstantsAction, signOffGoLiveAction } from "./actions";
import { GoLiveForm } from "./GoLiveForm";
import { MoneyApprovalForm } from "./MoneyApprovalForm";
import { V2Steps } from "./V2Steps";

export const dynamic = "force-dynamic";

type View = {
  signoffs: SignoffRow[];
  emailMode: string;
  marketMode: string;
  approval: MoneyApproval | null;
};

async function load(now: Date): Promise<View> {
  const db = mainDb();
  const [signoffs, email, market, approval] = await Promise.all([
    loadSignoffs(db),
    readEmailSwitch(db, marketDate(now, "Australia/Melbourne")),
    db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [GO_LIVE_MARKET] }),
    readMoneyApproval(db),
  ]);
  return {
    signoffs,
    emailMode: email.mode,
    approval,
    marketMode: market.rows.length === 1 ? String(market.rows[0]!.mode) : "unknown",
  };
}

const itemLabel = (id: string): string => GO_LIVE_ITEMS.find((i) => i.id === id)?.label ?? id;

export default async function GoLivePage() {
  const user = await requireUser("admin", "/ops/go-live");
  const tf = (await userPreferences(user.id)).time_format;
  let view: View | null = null;
  try {
    view = await load(new Date());
  } catch {
    view = null; // neutral message below; no error details
  }
  const production = isProductionEnv(process.env);
  const commit = deployedCommit(process.env);
  const signed = view !== null && view.signoffs.length > 0;
  const constants = moneyConstants();
  // R3-I2: attested = the id is named AND the stored value hash equals the figure's current hash.
  const hashes = moneyValueHashes(constants);
  const attested = new Set(
    (view?.approval?.ids ?? []).filter((id) => view?.approval?.hashes[id] === hashes[id]),
  );
  const pending = constants.filter((c) => !c.verified && !attested.has(c.id));

  return (
    <main className="mx-auto flex max-w-4xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {signed ? "Go-live record" : "Go-live sign-off"}
        </h1>
        {signed ? (
          <p className="m-0 text-sm text-text-muted">
            Praxis is live. This page keeps the sign-off record; there is nothing more to do here.
          </p>
        ) : (
          <p className="m-0 text-sm text-text-muted">
            Only you can use this page. Signing off records that every go-live check is done. It
            does not switch anything on. After it, set the {GO_LIVE_MARKET} market to full mode in{" "}
            <Link href="/health" className="underline">
              System Health
            </Link>
            .
          </p>
        )}
      </header>

      {view === null ? (
        <p role="status">The go-live page is unavailable. Nothing was changed.</p>
      ) : (
        <>
          <Card title="Where things stand" className="min-w-0">
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              <li>
                This deployment is {production ? "production" : "staging"}.{" "}
                {production
                  ? "Full mode is refused here until a sign-off exists and the email mode is not off."
                  : "Staging needs no sign-off."}
              </li>
              <li>
                {GO_LIVE_MARKET} market mode:{" "}
                {view.marketMode === "data_only"
                  ? "data only"
                  : view.marketMode === "off"
                    ? "off"
                    : view.marketMode === "full"
                      ? "full"
                      : "unknown"}
                .
              </li>
              <li>
                Email mode:{" "}
                {view.emailMode === "off" ? "off (set it to incidents only first)" : view.emailMode}
                .
              </li>
              <li>Sign-off recorded: {signed ? "yes" : "no"}.</li>
              <li>
                Release commit:{" "}
                {commit !== null ? (
                  <span className="font-mono">{commit}</span>
                ) : (
                  "not reported by this deployment"
                )}
              </li>
            </ul>
          </Card>

          <Card title="Money figures waiting for your approval" className="min-w-0">
            {pending.length === 0 ? (
              <p className="m-0 text-sm">
                Every cost, tick, slippage and parcel figure is approved
                {view.approval !== null
                  ? ` (you approved them ${formatMelbourne(view.approval.approvedAt, tf)})`
                  : ""}
                .
              </p>
            ) : (
              <>
                <p className="m-0 mb-2 text-sm">
                  {pending.length} of {constants.length} figures are not approved. Production stays
                  out of full mode until you approve them here.
                </p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                  {pending.map((c) => (
                    <li key={c.id}>
                      {c.label} <span className="text-text-muted">({c.specRef})</span>
                    </li>
                  ))}
                </ul>
                <MoneyApprovalForm
                  action={approveMoneyConstantsAction}
                  ids={constants.map((c) => c.id)}
                  phrase={MONEY_APPROVAL_PHRASE}
                />
              </>
            )}
          </Card>

          {/* D-174: once signed off, the checklist and the form are gone; only the record stays. */}
          {!signed && (
            <section aria-labelledby="signoff-h" className="flex flex-col gap-3">
              <h2 id="signoff-h" className="text-lg font-semibold">
                Checklist and sign-off
              </h2>
              <GoLiveForm
                action={signOffGoLiveAction}
                items={GO_LIVE_ITEMS.map((i) => ({ ...i }))}
                phrase={SIGNOFF_CONFIRM_PHRASE}
                noteMax={SIGNOFF_NOTE_MAX}
                askCommit={commit === null}
              />
            </section>
          )}

          {/* V2-S9 (D-706): shown before and after the V1 sign-off; V2 steps are not part of it. */}
          <section aria-labelledby="v2-h" className="flex flex-col gap-3">
            <h2 id="v2-h" className="text-lg font-semibold">
              V2 steps
            </h2>
            <p className="m-0 text-sm text-text-muted">
              What is left to do by hand before V2 is switched on, in the order to do it. These are
              not part of the sign-off.
            </p>
            <V2Steps
              phases={Object.entries(V2_PHASE_LABELS).map(([id, label]) => ({ id, label }))}
              steps={V2_GO_LIVE_STEPS.map((x) => ({ ...x, after: [...x.after] }))}
              guidePath={V2_GUIDE_PATH}
            />
          </section>

          <section aria-labelledby="history-h" className="flex flex-col gap-3">
            <h2 id="history-h" className="text-lg font-semibold">
              Sign-off record
            </h2>
            {view.signoffs.length === 0 ? (
              <EmptyState
                compact
                motif="check"
                hue="home"
                title="No sign-off has been recorded yet."
              />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {view.signoffs.map((s) => (
                  <li key={s.id} className="rounded-md bg-surface-2 p-3 text-sm">
                    <p className="m-0 font-semibold">
                      Signed off {formatMelbourne(s.signedAt, tf)} for commit{" "}
                      <span className="font-mono">{s.releaseCommit}</span>
                    </p>
                    <p className="m-0 mt-1 text-text-muted">
                      Items ticked: {s.items.map(itemLabel).join("; ")}.
                    </p>
                    {s.note !== "" && <p className="m-0 mt-1 break-words">{s.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
