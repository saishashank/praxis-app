// Settings > About (UXN-019): what Praxis is, which build is running, the data it uses and the
// attributions it must show, then every bundled library with its licence (generated at build from the
// lockfile by scripts/gen-notices.mjs) behind one collapsed section, so the page is not a wall of
// packages (Owner 2026-10-23, D-173). Read-only; every role may open it. A licence outside the
// allow-list shows the Owner's approval date (scripts/ci/licence-exceptions.json) or, if there is
// none, "needs Owner approval".
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { requireUser } from "@/lib/auth/guard";
import notices from "@/generated/notices.json";
import { SettingsFrame } from "../SettingsNav";

export const dynamic = "force-dynamic";

type Pkg = (typeof notices.packages)[number] & { approved?: string };

function licenceText(r: Pkg): string {
  if (r.allowed) return r.license;
  if (r.approved !== undefined) {
    return `${r.license} (approved by the Owner${r.approved ? `, ${r.approved}` : ""})`;
  }
  return `${r.license} (needs Owner approval)`;
}

const COLUMNS: Column<Pkg>[] = [
  { key: "name", header: "Library", cell: (r) => r.name },
  { key: "version", header: "Version", cell: (r) => r.version },
  { key: "license", header: "Licence", cell: (r) => licenceText(r) },
];

/** Where the data comes from (DAT-120 source register, plain words). */
const SOURCES: Array<[string, string]> = [
  ["Prices", "Yahoo Finance end-of-day prices, for personal, non-commercial use"],
  ["Company list and announcements", "ASX (asx.com.au), for personal use"],
  ["Short positions", "ASIC daily short position reports"],
];

export default async function AboutPage() {
  await requireUser("read", "/settings/about");
  const packages = notices.packages as Pkg[];
  const pending = packages.filter((p) => !p.allowed && p.approved === undefined).length;
  const approved = packages.filter((p) => !p.allowed && p.approved !== undefined).length;
  const build = (process.env.APP_COMMIT ?? "").slice(0, 7);
  return (
    <SettingsFrame
      title="About"
      intro="Praxis is a practice-only research tool. Every trade is simulated with pretend money; nothing here is financial advice."
    >
      <Card title="This build" headingLevel={2}>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-text-muted">Version</dt>
          <dd className="m-0 font-mono">{build || "—"}</dd>
          <dt className="text-text-muted">Market</dt>
          <dd className="m-0">Australia (ASX)</dd>
        </dl>
      </Card>
      <Card title="Data sources" headingLevel={2}>
        <dl className="m-0 grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
          {SOURCES.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="m-0">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Fonts and attribution" headingLevel={2}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {notices.fonts.map((f) => (
            <li key={f.name}>
              {f.name}: {f.license}. {f.note}
            </li>
          ))}
          {notices.attributions.map((a) => (
            <li key={a.name}>
              {a.text}{" "}
              <a href={a.href} rel="noopener noreferrer" className="text-accent underline">
                tradingview.com
              </a>
            </li>
          ))}
        </ul>
      </Card>
      <details className="ui-card min-w-0 rounded-lg border border-border bg-surface">
        <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-3">
          <span className="font-semibold">Open-source licences</span>
          <span className="text-sm text-text-muted" data-testid="notices-count">
            {packages.length} packages
            {approved > 0 ? `, ${approved} approved exceptions` : ""}
            {pending > 0 ? `, ${pending} need approval` : ""}
          </span>
        </summary>
        <div className="border-t border-border p-4">
          <DataTable
            caption="Bundled libraries with version and licence"
            columns={COLUMNS}
            rows={packages}
            rowKey={(r) => `${r.name}@${r.version}`}
          />
        </div>
      </details>
    </SettingsFrame>
  );
}
