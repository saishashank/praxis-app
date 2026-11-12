// Settings > Region & markets (UXN-282, UX-112 view, MKT-106). Every role sets the market the app opens
// in and whether times show in Melbourne or exchange time (own preferences). The markets table lists
// exchange, currency, hours in Melbourne time, status and build progress; the Owner sees every profile row,
// Editors and Viewers the enabled markets the Owner has shared (D-997). The Owner's switch-on card (checklist, quota projection, the two-step control and the rollback) follows the table (M20, UXN-312).
// Totals are never converted between currencies (O-34).
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { requireUser } from "@/lib/auth/guard";
import { loadMarketSwitch, loadSettings } from "@/lib/ui/loaders/settings";
import { envFor } from "@/lib/ui/loaders/shell";
import { melbourneDate } from "@/lib/view/active";
import { SettingsForm } from "../SettingsForm";
import { Select, SettingsFrame } from "../SettingsNav";
import { updateRegionAction } from "../actions";
import { MarketSwitch } from "./MarketSwitch";
import { switchMarketAction } from "./actions";
import {
  disabledReason,
  marketRows,
  readProfiles,
  readSharedMarkets,
  type MarketProfiles,
  type MarketRow,
} from "../region";

export const dynamic = "force-dynamic";

const COLUMNS: Column<MarketRow>[] = [
  { key: "code", header: "Market", cell: (r) => <strong data-market={r.code}>{r.code}</strong> },
  { key: "exchange", header: "Exchange", cell: (r) => r.exchange },
  { key: "currency", header: "Currency", cell: (r) => r.currency },
  { key: "hours", header: "Hours (Melbourne)", cell: (r) => r.hours ?? "n/a" },
  {
    key: "status",
    header: "Status",
    cell: (r) => (
      <>
        {r.statusText}
        {r.evidence !== null && <span className="block text-xs text-text-muted">{r.evidence}</span>}
        {r.gateItems.map((g) => (
          <span key={g} className="block text-xs text-text-muted">
            Open: {g}
          </span>
        ))}
        {r.profileLine !== null && (
          <span className="block text-xs text-text-muted">{r.profileLine}</span>
        )}
      </>
    ),
  },
  {
    key: "progress",
    header: "Build progress",
    cell: (r) =>
      r.status === "active" || r.status === "built"
        ? "Built"
        : r.progressPct === null
          ? "n/a"
          : `${r.progressPct} %`,
  },
];

/** The Owner's switch-on card model; any failure leaves the card out (the table above stands on its own). */
async function switchModelOf(env: Awaited<ReturnType<typeof envFor>>) {
  try {
    return await loadMarketSwitch(env);
  } catch {
    return null;
  }
}

export default async function RegionPage() {
  const user = await requireUser("own_preferences", "/settings/region");
  const env = await envFor({ id: user.id, role: user.role });
  const model = await loadSettings(env);
  const isOwner = user.role === "owner";
  const [profiles, shared] = await Promise.all([
    readProfiles(env.main).catch((): MarketProfiles => ({})),
    readSharedMarkets(env.auth).catch(() => new Set<string>()),
  ]);
  // Owner only (UXN-312): the checklist, the quota projection and the switch; a failing read leaves the card out
  const switchModel = isOwner ? await switchModelOf(env) : null;
  const today = melbourneDate(env.now.toISOString()) ?? "";
  const rows = marketRows(model, profiles, shared, isOwner, today);
  const prefs = model.preferences;
  const choosable = rows
    .filter((r) => r.selectable)
    .map((r): [string, string] => [r.code, `${r.code} (${r.exchange})`]);
  const blocked = rows.filter((r) => !r.selectable);
  return (
    <SettingsFrame
      title="Region & markets"
      intro="Where the app opens and which clock it uses. Each market keeps its own currency; totals are never converted between currencies."
    >
      <SettingsForm action={updateRegionAction}>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Region</legend>
          <Select
            name="default_market"
            label="Open the app in"
            value={prefs.default_market}
            options={choosable.length ? choosable : [[prefs.default_market, prefs.default_market]]}
            hint="Only active markets can be chosen."
          />
          {blocked.length > 0 && (
            <ul
              className="m-0 list-none p-0 text-xs text-text-muted"
              aria-label="Markets you cannot choose"
            >
              {blocked.map((r) => (
                <li key={r.code}>
                  {r.code} (disabled): {disabledReason(r)}
                </li>
              ))}
            </ul>
          )}
          <Select
            name="times_in"
            label="Show times in"
            value={prefs.times_in}
            options={[
              ["melbourne", "Melbourne time"],
              ["exchange", "Exchange-local time"],
            ]}
            hint="The Australian market keeps the same clock as Melbourne, so the two look the same until a second market opens."
          />
        </fieldset>
      </SettingsForm>
      <Card title="Markets" headingLevel={2}>
        <div data-markets-table>
          <DataTable
            caption="Markets, their hours in Melbourne time and status"
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.code}
          />
        </div>
        {isOwner && model.sharing !== null && (
          <p className="mt-3 text-xs text-text-muted" data-testid="sharing-summary">
            Sharing acknowledgements recorded: {model.sharing.acknowledgements}
            {model.sharing.lastAt ? `, latest ${model.sharing.lastAt.slice(0, 10)}` : ""}.
          </p>
        )}
        {!isOwner && (
          <p className="mt-3 text-xs text-text-muted">
            You see the markets the Owner has shared with you.
          </p>
        )}
      </Card>
      {switchModel !== null && <MarketSwitch markets={switchModel} action={switchMarketAction} />}
    </SettingsFrame>
  );
}
