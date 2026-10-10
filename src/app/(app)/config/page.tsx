// Configuration (UX-116, PLT-041). Owner only (ROL-102a). Shows every tunable value with its
// default, bounds and spec reference; Owner-editable keys have an edit form (value + reason);
// keys marked fixed by the spec are read-only. Below: the latest versions (before -> after).
import Link from "next/link";
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
import { updateConfigAction } from "./actions";

export const dynamic = "force-dynamic";

function Row({ r, tf }: { r: ConfigRow; tf: TimeFormat }) {
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-2 pr-4 font-normal">
        <span className="font-medium">{r.label}</span>
        <br />
        <span className="font-mono text-xs">{r.key}</span>
      </th>
      <td className="py-2 pr-4">
        {formatConfigValue(r.value, r.unit)}
        <br />
        <span className="text-xs text-text-muted">
          {r.source === "stored" && r.lastChange
            ? `Changed ${formatMelbourne(r.lastChange.at, tf)} (version ${r.lastChange.versionId})`
            : "Default"}
        </span>
      </td>
      <td className="py-2 pr-4">{formatConfigValue(r.default, r.unit)}</td>
      <td className="py-2 pr-4">{r.bounds}</td>
      <td className="py-2 pr-4">{r.ref}</td>
      <td className="py-2">
        {r.editable === "fixed" ? (
          <span>Fixed by the spec</span>
        ) : (
          <ConfigForm action={updateConfigAction} className="flex flex-col gap-2">
            <input type="hidden" name="key" value={r.key} />
            <input
              type="text"
              name="value"
              required
              maxLength={500}
              defaultValue={editText(r.value)}
              aria-label={`New value for ${r.label}`}
              className="rounded border px-2 py-1 font-mono text-xs"
            />
            <input
              type="text"
              name="reason"
              required
              maxLength={200}
              placeholder="Reason"
              aria-label={`Reason for changing ${r.label}`}
              className="rounded border px-2 py-1 text-xs"
            />
            <button type="submit" className="w-fit rounded border px-3 py-1 font-medium">
              Save
            </button>
          </ConfigForm>
        )}
      </td>
    </tr>
  );
}

export default async function ConfigPage() {
  const user = await requireUser("admin", "/config");
  const tf = (await userPreferences(user.id)).time_format;
  const db = mainDb();
  const [rows, history] = await Promise.all([listConfig(db), listConfigHistory(db, 20)]);
  const units = new Map(rows.map((r) => [r.key as string, r.unit]));

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-sm text-text-muted">
          Every change is saved as a new version with its reason and is audit-logged. Times are
          shown in Australia/Melbourne.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      {CONFIG_AREAS.map((area, i) => {
        const inArea = rows.filter((r) => r.area === area);
        if (!inArea.length) return null;
        return (
          <section key={area} aria-labelledby={`area-${i}`} className="flex flex-col gap-3">
            <h2 id={`area-${i}`} className="text-xl font-semibold">
              {area}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{area} settings</caption>
                <thead>
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Setting
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Current value
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Default
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Allowed
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Spec ref
                    </th>
                    <th scope="col" className="py-2">
                      Edit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inArea.map((r) => (
                    <Row key={r.key} r={r} tf={tf} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section aria-labelledby="history-h" className="flex flex-col gap-3">
        <h2 id="history-h" className="text-xl font-semibold">
          Recent changes
        </h2>
        {history.length === 0 ? (
          <p className="text-sm">No changes yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Latest configuration versions</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Setting
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Before to after
                  </th>
                  <th scope="col" className="py-2">
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const unit = units.get(h.key) ?? "";
                  return (
                    <tr key={h.id} className="border-t border-border align-top">
                      <td className="py-2 pr-4 whitespace-nowrap">{formatMelbourne(h.at, tf)}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{h.key}</td>
                      <td className="py-2 pr-4">
                        {formatConfigValue(h.before, unit)} {"→"} {formatConfigValue(h.after, unit)}
                      </td>
                      <td className="py-2">{h.reason ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}
