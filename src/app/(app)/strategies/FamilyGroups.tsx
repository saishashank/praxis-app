// "Group by family" (UXN-255, D-1201): a list above the Strategies grid with one native <details> per
// family that lists the family's tiles as links to them. It is a way to jump, not a filter: the full grid below
// stays visible and unfiltered whether a group is open or closed, and the page needs no script.

export type FamilyGroupTile = {
  execution: string;
  family: string;
  /** The plain family name. */
  name: string;
  /** "Plain shares" or "With leverage sleeve". */
  moneyType: string;
};

export function FamilyGroups({
  tiles,
  open = false,
}: {
  tiles: FamilyGroupTile[];
  /** Start with every group open; the default is closed. */
  open?: boolean;
}) {
  const groups = new Map<string, { name: string; tiles: FamilyGroupTile[] }>();
  for (const t of tiles) {
    const g = groups.get(t.family) ?? { name: t.name, tiles: [] };
    g.tiles.push(t);
    groups.set(t.family, g);
  }
  if (groups.size === 0) return null;
  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section aria-labelledby="family-groups-h" className="flex min-w-0 flex-col gap-2">
      <h2 id="family-groups-h" className="m-0 text-xl font-semibold">
        Group by family
      </h2>
      <p className="m-0 text-sm text-text-muted">
        Open a family to jump to its strategies. Every strategy stays in the lists below.
      </p>
      <ul className="m-0 grid min-w-0 list-none grid-cols-1 gap-2 p-0 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((g) => (
          <li key={g.name} className="min-w-0">
            <details
              open={open}
              data-family-group=""
              className="rounded-lg border border-border bg-surface p-3"
            >
              <summary className="cursor-pointer text-sm font-semibold">
                {g.name} ({g.tiles.length} {g.tiles.length === 1 ? "strategy" : "strategies"})
              </summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm">
                {g.tiles.map((t) => (
                  <li key={t.execution} className="min-w-0 break-words">
                    <a href={`#tile-${t.execution}`}>
                      {t.name}, {t.moneyType.toLowerCase()}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
