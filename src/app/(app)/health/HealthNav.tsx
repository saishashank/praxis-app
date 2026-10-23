// Section menu for System Health (Owner 2026-10-23: "the system health can have a menu on left as
// there are a lot of sections", D-174). Desktop: a sticky list on the left. Phone: one "Jump to a
// section" disclosure at the top. Plain in-page links to each section heading; no client code.
export type HealthNavItem = { id: string; label: string };

function Links({ items }: { items: HealthNavItem[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
      {items.map((i) => (
        <li key={i.id}>
          <a
            href={`#${i.id}`}
            className="flex min-h-9 items-center rounded-md px-3 text-text-muted no-underline hover:bg-surface-2 hover:text-text"
          >
            {i.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function HealthNav({ items }: { items: HealthNavItem[] }) {
  return (
    <>
      <nav aria-label="Health sections" className="hidden lg:block">
        <div className="ui-card sticky top-20 rounded-lg border border-border bg-surface p-2">
          <p className="m-0 px-3 pt-1 pb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
            Sections
          </p>
          <Links items={items} />
        </div>
      </nav>
      <details className="ui-card rounded-lg border border-border bg-surface lg:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium">
          Jump to a section
        </summary>
        <nav aria-label="Health sections (phone)" className="border-t border-border p-2">
          <Links items={items} />
        </nav>
      </details>
    </>
  );
}
