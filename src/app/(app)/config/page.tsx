// Configuration (UX-116, PLT-041). Owner only (ROL-102a). Read-only (D-174, Owner 2026-10-23: "I
// do not want to alter any configs from the UI, just show it"): every tunable value with its
// default, bounds and spec reference, and the latest versions (before -> after). Values change only
// through a reviewed code change; the update action stays on the server but no page offers it.
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
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

// UXR-028 with D-174: a searchable list, read-only. Search is a plain GET form (?q=), so it works
// without JavaScript and the page stays a server component. A "changed" dot marks a stored value.
function Row({ r, tf }: { r: ConfigRow; tf: TimeFormat }) {
  const changed = r.source === "stored";
  return (
    <li
      data-config-key={r.key}
      className="flex min-w-0 flex-col gap-2 border-t border-border py-3 first:border-t-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {changed ? (
          <span
            data-changed=""
            title="Changed from the default"
            className="inline-flex items-center gap-1 text-xs font-semibold text-text"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
            Changed
          </span>
        ) : null}
        <span className="font-medium">{r.label}</span>
        <span className="font-mono text-xs break-all text-text-muted">{r.key}</span>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-text-muted">Current value</dt>
          <dd className="m-0 font-semibold">{formatConfigValue(r.value, r.unit)}</dd>
          {changed && r.lastChange ? (
            <dd className="m-0 text-xs text-text-muted">
              {`Changed ${formatMelbourne(r.lastChange.at, tf)} (version ${r.lastChange.versionId})`}
            </dd>
          ) : null}
        </div>
        <div>
          <dt className="text-xs text-text-muted">Default</dt>
          <dd className="m-0">{formatConfigValue(r.default, r.unit)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Allowed</dt>
          <dd className="m-0">
            {r.bounds} <span className="text-text-muted">({r.ref})</span>
          </dd>
        </div>
      </dl>
    </li>
  );
}

const matches = (r: ConfigRow, q: string): boolean =>
  !q || `${r.key} ${r.label}`.toLowerCase().includes(q);

export default async function ConfigPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string | string[] }>;
} = {}) {
  const user = await requireUser("admin", "/config");
  const tf = (await userPreferences(user.id)).time_format;
  const db = mainDb();
  const [rows, history] = await Promise.all([listConfig(db), listConfigHistory(db, 20)]);
  const rawQ = (await searchParams)?.q;
  const q = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.trim().toLowerCase().slice(0, 80) ?? "";
  const shown = rows.filter((r) => matches(r, q));
  const units = new Map(rows.map((r) => [r.key as string, r.unit]));

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="m-0 text-sm text-text-muted">
          Every tunable value with its default and allowed range, so you can see what the system is
          using. Read-only: changes are made in code and reviewed, never from this page. Times are
          shown in Australia/Melbourne.
        </p>
        <form method="get" role="search" className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 grow flex-col gap-1 text-sm sm:max-w-sm">
            <span className="sr-only">Search settings</span>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search by name or key"
              maxLength={80}
              className="min-h-6 min-w-0 rounded-md border border-border bg-bg p-2 text-text"
            />
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            Search
          </button>
        </form>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      {q && shown.length === 0 ? (
        <EmptyState title="No setting matches that search">
          Try part of a name, such as &ldquo;retention&rdquo;, or clear the search.
        </EmptyState>
      ) : null}

      {CONFIG_AREAS.map((area) => {
        const inArea = shown.filter((r) => r.area === area);
        if (!inArea.length) return null;
        return (
          <Card key={area} aria-label={CONFIG_AREA_LABEL[area]} title={CONFIG_AREA_LABEL[area]}>
            <ul
              aria-label={`${CONFIG_AREA_LABEL[area]} settings`}
              className="m-0 flex list-none flex-col p-0"
            >
              {inArea.map((r) => (
                <Row key={r.key} r={r} tf={tf} />
              ))}
            </ul>
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
