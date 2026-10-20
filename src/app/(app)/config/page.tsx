// Configuration (UX-116, PLT-041). Owner only (ROL-102a). Shows every tunable value with its
// default, bounds and spec reference; Owner-editable keys have an edit form (value + reason);
// keys marked fixed by the spec are read-only. Below: the latest versions (before -> after).
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import {
  editText,
  formatConfigValue,
  listConfig,
  listConfigHistory,
  type ConfigRow,
} from "@/lib/config/admin";
import { CONFIG_AREAS } from "@/lib/config/keys";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne, type TimeFormat } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { ConfigForm } from "./ConfigForm";
import { RCell, RHead, RRow, RTable } from "@/components/ui/ResponsiveTable";
import { updateConfigAction } from "./actions";

export const dynamic = "force-dynamic";

const FIELD = "min-h-6 w-full min-w-0 rounded-md border border-border bg-bg p-2 text-text";

const HEADERS = ["Setting", "Current value", "Default", "Allowed", "Spec ref", "Edit"] as const;

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
      <RCell label="Edit" className="sm:min-w-48">
        {r.locked ? (
          <span>Changes only as a new rule version (Lane B)</span>
        ) : r.editable === "fixed" ? (
          <span>
            {r.key === "market_mode" ? "Set on System Health (Data controls)" : "Fixed by the spec"}
          </span>
        ) : (
          <ConfigForm action={updateConfigAction} className="flex flex-col gap-2 sm:items-start">
            <input type="hidden" name="key" value={r.key} />
            <input
              type="text"
              name="value"
              required
              maxLength={500}
              defaultValue={editText(r.value)}
              aria-label={`New value for ${r.label}`}
              className={`${FIELD} font-mono text-xs`}
            />
            <input
              type="text"
              name="reason"
              required
              maxLength={200}
              placeholder="Reason"
              aria-label={`Reason for changing ${r.label}`}
              className={`${FIELD} text-xs`}
            />
            <Button type="submit" variant="secondary" className="w-fit self-end sm:self-start">
              Save
            </Button>
          </ConfigForm>
        )}
      </RCell>
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
          Every change is saved as a new version with its reason and is audit-logged. Times are
          shown in Australia/Melbourne.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      {CONFIG_AREAS.map((area) => {
        const inArea = rows.filter((r) => r.area === area);
        if (!inArea.length) return null;
        return (
          <Card key={area} aria-label={area} title={area}>
            <RTable caption={`${area} settings`} headers={HEADERS}>
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
