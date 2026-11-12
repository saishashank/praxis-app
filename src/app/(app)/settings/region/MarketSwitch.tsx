// Settings > Region & markets > Switch-on (MKT-111, UXN-312, D-1100, D-1101; M20 S1). Owner only (the page decides; the
// action re-checks the role). For each built market other than the home market: its mode, the switch-on checklist of the
// NEXT step with each item's evidence, the quota projection with AU and the enabled markets, and the control: the
// next step is enabled only when every item of that step is ok (the writer re-checks all of it), the rollback button
// asks for a reason. Editors and Viewers never reach this component (D-997).
import Link from "next/link";
import { DataControlForm } from "@/app/(app)/health/DataControlForm";
import { Card } from "@/components/ui/Card";
import type { SwitchMarketModel } from "@/lib/ui/loaders/settings";
import type { SwitchActionResult } from "./actions";

const NEXT_LABEL = {
  data_only: "Switch on (data only)",
  full: "Switch to full",
} as const;

const NEXT_EXPLAIN = {
  data_only:
    "The market starts collecting data only: prices, announcements and quality checks. No books are opened and no e-mails are sent. After at least five good trading days and ten bar-latency samples you can switch it to full. This is recorded with your reason.",
  full: "The market opens its books with the starting money set from today's exchange rate, from the next trading day. Roll back goes straight to off and closes every open position at the next open.",
} as const;

const MODE_WORDS: Record<string, string> = {
  off: "Off",
  data_only: "Collecting data only",
  full: "Full",
};

const nf = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });

/** An evidence reference: an app path is a link, a repository path is shown as text (the docs are not served). */
function Evidence({ value }: { value: string | null }) {
  if (value === null) return null;
  return value.startsWith("/") ? (
    <Link href={value} className="text-accent underline">
      Evidence
    </Link>
  ) : (
    <code className="text-xs">{value}</code>
  );
}

function ProjectionLines({ m }: { m: SwitchMarketModel }) {
  if (m.projection === null) {
    return (
      <p className="m-0 text-xs text-text-muted" data-testid="projection-note">
        Quota projection: {m.projectionNote ?? "not available yet."}
      </p>
    );
  }
  return (
    <div data-testid="projection-lines">
      <p className="m-0 text-xs font-medium">
        Quota projection with AU and the enabled markets:{" "}
        {m.projection.fits ? "fits" : "does not fit"} (<Link href="/usage#projection">details</Link>
        )
      </p>
      <ul className="m-0 mt-1 list-none p-0 text-xs text-text-muted">
        {m.projection.verdicts.map((v) => (
          <li key={v.metric} data-metric={v.metric} data-ok={v.ok ? "1" : "0"}>
            {v.label}: {nf.format(v.sharePct)} % of its budget{" "}
            {v.ok ? "(within the line)" : "(over the line)"}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MarketBlock({
  m,
  action,
}: {
  m: SwitchMarketModel;
  action: (fd: FormData) => Promise<SwitchActionResult>;
}) {
  const open = m.items.filter((i) => !i.ok);
  return (
    <div
      data-market={m.code}
      data-mode={m.mode}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <h3 className="m-0 text-base font-semibold">
        {m.name} ({m.code}): {MODE_WORDS[m.mode] ?? m.mode}
      </h3>
      {m.rollbackPending && (
        <p className="m-0 text-sm" data-testid="rollback-pending">
          Rollback in progress: every open position closes at the next open, then the market is
          switched off. Nothing can be switched until it has run.
        </p>
      )}
      {m.next !== null && (
        <>
          <p className="m-0 text-sm font-medium">
            Checklist for the step to {m.next === "full" ? "full" : "data only"}:
          </p>
          <ul
            aria-label={`Checklist for ${m.code}`}
            className="m-0 flex list-none flex-col gap-1 p-0 text-sm"
          >
            {m.items.map((i) => (
              <li key={i.id} data-item={i.id} data-ok={i.ok ? "1" : "0"}>
                <span className="font-medium">{i.ok ? "Done" : "Open"}:</span> {i.text}{" "}
                <Evidence value={i.evidence} />
              </li>
            ))}
          </ul>
          <ProjectionLines m={m} />
          {m.complete ? (
            <DataControlForm
              action={action}
              fields={{ market: m.code, to: m.next }}
              label={NEXT_LABEL[m.next]}
              explain={NEXT_EXPLAIN[m.next]}
              confirmLabel="Confirm"
              inputs={[{ name: "reason", label: "Reason (optional)", type: "text" }]}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="w-fit rounded border px-3 py-1 text-sm opacity-60"
              >
                {NEXT_LABEL[m.next]}
              </button>
              <p className="m-0 text-xs text-text-muted" data-testid="open-items">
                Disabled:{" "}
                {open.length === 0
                  ? "the checklist could not be read."
                  : `${open.length} item${open.length === 1 ? "" : "s"} open (${open.map((i) => i.id).join(", ")}).`}
              </p>
            </div>
          )}
        </>
      )}
      {m.canRollback && (
        <DataControlForm
          action={action}
          fields={{ market: m.code, to: "off" }}
          label="Roll back to off"
          explain={
            m.mode === "full"
              ? "The market goes to off now. Every open position is closed at the next open, orders still waiting are cancelled, and no new orders are placed. All stored data stays. The reason is recorded."
              : "The market goes to off now. It holds no positions, so nothing needs closing. All stored data stays. The reason is recorded."
          }
          confirmLabel="Roll back"
          inputs={[{ name: "reason", label: "Reason (required)", type: "text", required: true }]}
        />
      )}
    </div>
  );
}

export function MarketSwitch({
  markets,
  action,
}: {
  markets: SwitchMarketModel[];
  action: (fd: FormData) => Promise<SwitchActionResult>;
}) {
  if (markets.length === 0) return null;
  return (
    <Card title="Switch on a market" headingLevel={2} data-testid="market-switch">
      <p className="mb-3 text-xs text-text-muted">
        A market is switched on in two steps: collecting data only, then full. The button works only
        when every checklist item of the step is done. After a switch, set the production setting
        for the enabled markets by hand (the nightly check reminds you).
      </p>
      <div className="flex flex-col gap-4">
        {markets.map((m) => (
          <MarketBlock key={m.code} m={m} action={action} />
        ))}
      </div>
    </Card>
  );
}
