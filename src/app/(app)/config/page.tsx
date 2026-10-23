// Configuration (UX-116, PLT-041). Owner only (ROL-102a). Read-only (D-174, Owner 2026-10-23: "I
// do not want to alter any configs from the UI, just show it"): every tunable value with its
// default, bounds and spec reference, and the latest versions (before -> after). Values change only
// through a reviewed code change; the update action stays on the server but no page offers it.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import {
  formatConfigValue,
  listConfig,
  listConfigHistory,
  type ConfigRow,
} from "@/lib/config/admin";
import { CONFIG_AREAS, CONFIG_AREA_LABEL } from "@/lib/config/keys";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne, type TimeFormat } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { RCell, RHead, RRow, RTable } from "@/components/ui/ResponsiveTable";

export const dynamic = "force-dynamic";

const HEADERS = ["Setting", "Current value", "Default", "Allowed", "Spec ref"] as const;

function Row({ r, tf }: { r: ConfigRow; tf: TimeFormat }) {
  return (
    <RRow>
      <RHead>
        <span className="block font-medium">{r.label}</span>
        <span className="block font-mono text-xs font-normal">{r.key}</span>
      </RHead>
      <RCell label="Current value">
        <div>{formatConfigValue(r.value, r.unit)}</div>
        <span className="text-xs text-text-muted">
          {r.source === "stored" && r.lastChange
            ? `Changed ${formatMelbourne(r.lastChange.at, tf)} (version ${r.lastChange.versionId})`
            : "Default"}
        </span>
      </RCell>
      <RCell label="Default">{formatConfigValue(r.default, r.unit)}</RCell>
      <RCell label="Allowed">{r.bounds}</RCell>
      <RCell label="Spec ref">{r.ref}</RCell>
    </RRow>
  );
}

export default async function ConfigPage() {
  const user = await requireUser("admin", "/config");
  const tf = (await userPreferences(user.id)).time_format;
  const db = mainDb();
  const [rows, history] = await Promise.all([listConfig(db), listConfigHistory(db, 20)]);
  const units = new Map(rows.map((r) => [r.key as string, r.unit]));

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="m-0 text-sm text-text-muted">
          Read-only: every value with its default and allowed range. Changes are made in code and
          reviewed, never from this page. Times are shown in Australia/Melbourne.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      {CONFIG_AREAS.map((area) => {
        const inArea = rows.filter((r) => r.area === area);
        if (!inArea.length) return null;
        return (
          <Card key={area} aria-label={CONFIG_AREA_LABEL[area]} title={CONFIG_AREA_LABEL[area]}>
            <RTable caption={`${CONFIG_AREA_LABEL[area]} settings`} headers={HEADERS}>
              {inArea.map((r) => (
                <Row key={r.key} r={r} tf={tf} />
              ))}
            </RTable>
          </Card>
        );
      })}

      <Card aria-label="Recent changes" title="Recent changes">
        {history.length === 0 ? (
          <EmptyState title="No changes yet." />
        ) : (
          <RTable
            caption="Latest configuration versions"
            headers={["When", "Setting", "Before to after", "Reason"]}
          >
            {history.map((h) => {
              const unit = units.get(h.key) ?? "";
              return (
                <RRow key={h.id}>
                  <RHead>
                    <span className="sm:whitespace-nowrap">{formatMelbourne(h.at, tf)}</span>
                  </RHead>
                  <RCell label="Setting">
                    <span className="font-mono text-xs">{h.key}</span>
                  </RCell>
                  <RCell label="Before to after">
                    {formatConfigValue(h.before, unit)} {"→"} {formatConfigValue(h.after, unit)}
                  </RCell>
                  <RCell label="Reason">{h.reason ?? ""}</RCell>
                </RRow>
              );
            })}
          </RTable>
        )}
      </Card>

      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}
