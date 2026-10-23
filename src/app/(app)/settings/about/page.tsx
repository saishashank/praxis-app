// Settings > About (UXN-019): every bundled library and font with its licence and the attribution it
// requires, generated at build from the lockfile (scripts/gen-notices.mjs). Read-only; every role may
// open it. A licence outside the allow-list is flagged so the Owner can approve an exception.
import { Card } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { requireUser } from "@/lib/auth/guard";
import notices from "@/generated/notices.json";
import { SettingsFrame } from "../SettingsNav";

export const dynamic = "force-dynamic";

type Pkg = (typeof notices.packages)[number];

const COLUMNS: Column<Pkg>[] = [
  { key: "name", header: "Library", cell: (r) => r.name },
  { key: "version", header: "Version", cell: (r) => r.version },
  {
    key: "license",
    header: "Licence",
    cell: (r) => (r.allowed ? r.license : `${r.license} (needs Owner approval)`),
  },
];

export default async function AboutPage() {
  const user = await requireUser("read", "/settings/about");
  const flagged = notices.packages.filter((p) => !p.allowed).length;
  return (
    <SettingsFrame
      title="About"
      intro="Praxis is a practice-only research tool. All trades are simulated. It is built on the open-source libraries and fonts listed here."
    >
      <Card title="Fonts" headingLevel={2}>
        <ul className="m-0 list-none p-0 text-sm">
          {notices.fonts.map((f) => (
            <li key={f.name}>
              {f.name}: {f.license}. {f.note}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Attribution" headingLevel={2}>
        <ul className="m-0 list-none p-0 text-sm">
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
      <Card title="Libraries" headingLevel={2}>
        <p className="mt-0 text-xs text-text-muted" data-testid="notices-count">
          {notices.packages.length} packages
          {flagged > 0 ? `, ${flagged} with a licence outside the approved list` : ""}.
        </p>
        <DataTable
          caption="Bundled libraries with version and licence"
          columns={COLUMNS}
          rows={notices.packages}
          rowKey={(r) => `${r.name}@${r.version}`}
        />
      </Card>
    </SettingsFrame>
  );
}
