// Vocabulary-gap report (KB-079, D-533). Pure and deterministic; never an LLM. Groups the free-text gap of each
// claim by a normalised input token and counts distinct experts and claims. Adding an indicator stays an
// Owner-approved build change.

export type GapInput = {
  readonly claimId: string;
  readonly expertIds: readonly string[];
  readonly clusterIds: readonly string[];
  readonly vocabularyGapText: string | null;
};
export type GapRow = {
  readonly input: string;
  readonly experts: number;
  readonly claims: number;
  readonly clusters: readonly string[];
};

/** Lower-case, the first phrase before a comma, semicolon, parenthesis or full stop, whitespace collapsed. */
export function normaliseGap(text: string): string {
  const first = text.split(/[,;(.]/)[0] ?? "";
  return first.toLowerCase().replace(/\s+/g, " ").trim();
}

export function gapReport(claims: readonly GapInput[]): GapRow[] {
  const groups = new Map<
    string,
    { experts: Set<string>; claims: Set<string>; clusters: Set<string> }
  >();
  for (const c of claims) {
    if (c.vocabularyGapText === null) continue;
    const key = normaliseGap(c.vocabularyGapText);
    if (key === "" || key === "none" || key === "n/a") continue;
    const g = groups.get(key) ?? { experts: new Set(), claims: new Set(), clusters: new Set() };
    for (const e of c.expertIds) g.experts.add(e);
    g.claims.add(c.claimId);
    for (const k of c.clusterIds) g.clusters.add(k);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([input, g]) => ({
      input,
      experts: g.experts.size,
      claims: g.claims.size,
      clusters: [...g.clusters].sort(),
    }))
    .sort((a, b) => b.experts - a.experts || b.claims - a.claims || (a.input < b.input ? -1 : 1));
}

/** "N experts rely on X (not in Praxis)". */
export function gapSentence(r: GapRow): string {
  return `${r.experts} ${r.experts === 1 ? "expert relies" : "experts rely"} on ${r.input} (not in Praxis)`;
}
