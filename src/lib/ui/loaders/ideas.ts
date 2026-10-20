// Loader of "Tonight's trade ideas" (the signals of one session, grouped by strategy; taken or not
// taken with the reason) and the tally shown with them (M7 T7; docs/M7_design.md 3 row 15; UX-040,
// UXN-126; D-128, D-129, D-135 draft). Masked viewers see "Stock A" and no signal or card ids that
// contain a code; the card link is the opaque `ck:` reference (see cards.ts).
import "server-only";
import { cardHref } from "./cards";
import {
  loaded,
  num,
  openViewer,
  str,
  strategyNames,
  strOrNull,
  type Loaded,
  type LoaderDeps,
} from "./common";

const MAX_SIGNALS = 500; // threshold-ok: bound of one session's signals read
const MAX_CARDS = 2_000; // threshold-ok: bound of one session's cards read
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type IdeaCard = {
  href: string;
  execution: string;
  taken: boolean;
  /** Why it was not taken (masked text); null for a taken card. */
  reason: string | null;
};

export type Idea = {
  stock: string;
  variant: string;
  regime: string;
  rankScore: string;
  cards: IdeaCard[];
  taken: number;
  notTaken: number;
};

export type IdeaGroup = { family: string; strategy: string; ideas: Idea[] };

export type IdeasView = {
  market: string;
  /** The session the ideas are for; null when there are no signals yet. */
  d: string | null;
  groups: IdeaGroup[];
  tally: { signals: number; taken: number; notTaken: number };
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyView(market: string): IdeasView {
  return { market, d: null, groups: [], tally: { signals: 0, taken: 0, notTaken: 0 } };
}

export async function loadIdeas(
  deps: LoaderDeps,
  params: { d?: string | null } = {},
): Promise<Loaded<IdeasView>> {
  const v = await openViewer(deps);
  const market = v.market;
  const masked = v.masker.masked;
  const wanted = params.d && DATE_RE.test(params.d) ? params.d : null;
  const dr = await deps.mainDb.execute({
    sql: wanted
      ? "SELECT MAX(d) AS d FROM signal WHERE market = ? AND d = ?"
      : "SELECT MAX(d) AS d FROM signal WHERE market = ?",
    args: wanted ? [market, wanted] : [market],
  });
  const d = strOrNull(dr.rows[0]?.d);
  if (d === null) {
    return loaded(
      null,
      v.now,
      masked,
      emptyView(market),
      "No trade ideas yet: the strategies start when the market is switched on.",
    );
  }

  const sig = await deps.mainDb.execute({
    sql: `SELECT id, family, variant, code, regime, rank_score FROM signal
          WHERE market = ? AND d = ? ORDER BY family, variant, code, id LIMIT ?`,
    args: [market, d, MAX_SIGNALS],
  });
  const cards = await deps.mainDb.execute({
    sql: `SELECT c.id, c.signal_id, c.execution_id, c.taken, c.not_taken_reason
          FROM decision_card c JOIN signal s ON s.id = c.signal_id
          WHERE s.market = ? AND s.d = ? ORDER BY c.execution_id, c.id LIMIT ?`,
    args: [market, d, MAX_CARDS],
  });

  // Codes are collected first, letters are given afterwards.
  const scope = await v.masker.scope(
    d,
    sig.rows.map((r) => str(r.code)),
  );
  const names = await strategyNames(deps.mainDb);
  const bySignal = new Map<string, IdeaCard[]>();
  for (const c of cards.rows) {
    const list = bySignal.get(str(c.signal_id)) ?? [];
    const taken = num(c.taken) === 1;
    list.push({
      href: cardHref(str(c.id), masked),
      execution: str(c.execution_id),
      taken,
      reason: taken ? null : scope.text(strOrNull(c.not_taken_reason) ?? "reason not recorded"),
    });
    bySignal.set(str(c.signal_id), list);
  }

  const groups = new Map<string, Idea[]>();
  const order = new Map<Idea, { score: number; code: string }>();
  let taken = 0;
  let notTaken = 0;
  for (const r of sig.rows) {
    const list = bySignal.get(str(r.id)) ?? [];
    const idea: Idea = {
      stock: scope.label(str(r.code)),
      variant: str(r.variant),
      regime: str(r.regime),
      rankScore: str(r.rank_score),
      cards: list,
      taken: list.filter((x) => x.taken).length,
      notTaken: list.filter((x) => !x.taken).length,
    };
    taken += idea.taken;
    notTaken += idea.notTaken;
    const score = Number(str(r.rank_score));
    order.set(idea, { score: Number.isFinite(score) ? score : -Infinity, code: str(r.code) });
    const fam = str(r.family);
    groups.set(fam, [...(groups.get(fam) ?? []), idea]);
  }
  const out: IdeaGroup[] = [...groups.keys()].sort(cmp).map((family) => ({
    family,
    strategy: names[family]?.name ?? family,
    ideas: groups.get(family)!.sort((a, b) => {
      const x = order.get(a)!;
      const y = order.get(b)!;
      return y.score - x.score || cmp(x.code, y.code);
    }),
  }));

  return loaded(d, v.now, masked, {
    market,
    d,
    groups: out,
    tally: { signals: sig.rows.length, taken, notTaken },
  });
}
