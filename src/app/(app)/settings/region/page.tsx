// Settings > Region & markets (UXN-282, UX-112 view, MKT-106). Every role sets the market the app opens
// in and whether times show in Melbourne or exchange time (own preferences). The markets table lists
// exchange, currency, hours in Melbourne time, status and build progress; Editors and Viewers see only
// AU and the markets the Owner has shared. Activating a market is the Owner's job elsewhere, not here.
// Totals are never converted between currencies (O-34).
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { requireUser } from "@/lib/auth/guard";
import { loadSettings } from "@/lib/ui/loaders/settings";
import { envFor } from "@/lib/ui/loaders/shell";
import { melbourneDate } from "@/lib/view/active";
import { SettingsForm } from "../SettingsForm";
import { Select, SettingsFrame } from "../SettingsNav";
import { updateRegionAction } from "../actions";
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
  { key: "code", header: "Market", cell: (r) => <strong>{r.code}</strong> },
  { key: "exchange", header: "Exchange", cell: (r) => r.exchange },
  { key: "currency", header: "Currency", cell: (r) => r.currency },
  { key: "hours", header: "Hours (Melbourne)", cell: (r) => r.hours ?? "n/a" },
  { key: "status", header: "Status", cell: (r) => r.statusText },
  {
    key: "progress",
    header: "Build progress",
    cell: (r) =>
      r.status === "active" ? "Built" : r.progressPct === null ? "n/a" : `${r.progressPct} %`,
  },
];

export default async function RegionPage() {
  const user = await requireUser("own_preferences", "/settings/region");
  const env = await envFor({ id: user.id, role: user.role });
  const model = await loadSettings(env);
  const isOwner = user.role === "owner";
  const [profiles, shared] = await Promise.all([
    readProfiles(env.main).catch((): MarketProfiles => ({})),
    readSharedMarkets(env.auth).catch(() => new Set<string>()),
  ]);
  const today = melbourneDate(env.now.toISOString()) ?? "";
  const rows = marketRows(model, profiles, shared, isOwner, today);
  const prefs = model.preferences;
  const choosable = rows
    .filter((r) => r.selectable)
    .map((r): [string, string] => [r.code, `${r.code} (${r.exchange})`]);
  const blocked = rows.filter((r) => !r.selectable);
  return (
    <SettingsFrame
      tab="region"
      role={user.role}
      intro="Where the app opens and which clock it uses. Each market keeps its own currency; totals are never converted between currencies."
    >
      <SettingsForm action={updateRegionAction}>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-medium">Region</legend>
          <Select
            name="default_market"
            label="Open the app in"
            value={prefs.default_market}
            options={choosable.length ? choosable : [["AU", "AU (ASX)"]]}
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
        <DataTable
          caption="Markets, their hours in Melbourne time and status"
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.code}
        />
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
    </SettingsFrame>
  );
}
