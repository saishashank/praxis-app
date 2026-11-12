// D-909 (Owner 2026-11-09): "check if picks are good the next day ... what you missed and why ...
// analyse the top movers and top losers and see why you didn't spot it". A section of the Evening
// Review (section 6, "What needs improving for tomorrow"), built from the stored night:
//   1. last night's published picks: how many, and what they did today (the move from last night's
//      reference price; stop / aim levels touched by today's bar);
//   2. the session's 10 biggest gainers and 10 biggest losers of the active universe (close to close,
//      liquid tiers), and for each: was it last night's pick, did a strategy signal it (and was the
//      trade blocked, and why), and was there a price-sensitive announcement before the open, during
//      the day, or none.
// Descriptive only: nothing here feeds tonight's decisions (as the learning loop). Every read is
// bounded by the session and its predecessor and by the 20 codes (indexed: price_bar (market, d),
// universe_snapshot PK, signal and blocked_trade (market, d), announcement (market, code, ...)).
import type { CalendarRow } from "@/lib/data/calendar";
import { addDays, isTradingDay } from "@/lib/data/calendar";
import { homeProfile } from "@/lib/market/staticProfile.mjs";
import type { Ctx } from "./sections";
import { companyNames, familyNames } from "./names";

export const MOVERS_LISTED = 10; // threshold-ok: gainers and losers listed in the review
const LIQUID_TIERS = ["U1", "U2"] as const;
const PPM = 1_000_000; // threshold-ok: parts per million
/** The home market opens its continuous session at this time of its own zone; an announcement before it was knowable at the open. */
const OPEN_HHMM = homeProfile().sessionOpen!;
const MARKET_TZ = homeProfile().tz!;

export type MoverFact = {
  readonly code: string;
  /** Company name (display form), null when unknown. */
  readonly name: string | null;
  readonly movePpm: number;
  /** Plain words: picked / signalled (and blocked why) / not seen. */
  readonly seen: string;
  /** Plain words: the news behind it, or "no announcement". */
  readonly news: string;
};

export type MissedMoversFacts = {
  readonly lines: string[];
  readonly gainers: MoverFact[];
  readonly losers: MoverFact[];
};

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v); // money-float-ok: SQL price or count for display

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  skipped_stop_distance: "the stop was too far away",
  skipped_cost_gate: "costs would eat the expected gain",
};
const blockWords = (r: string): string =>
  BLOCK_WORDS[r] ?? r.replace(/^skipped_/, "").replace(/_/g, " ");

function prevSession(d: string, calendar: readonly CalendarRow[]): string {
  let x = addDays(d, -1);
  for (let i = 0; i < 14 && !isTradingDay(x, calendar); i += 1) x = addDays(x, -1); // threshold-ok: holiday scan
  return x;
}

/** HH:MM of an instant in Sydney time (the exchange clock). */
function sydneyHhmm(iso: string): { d: string; hhmm: string } {
  const t = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(t);
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { d: `${g("year")}-${g("month")}-${g("day")}`, hhmm: `${g("hour")}:${g("minute")}` };
}

export const pctText = (ppm: number): string =>
  `${ppm > 0 ? "+" : ""}${(ppm / 10_000).toFixed(1)} %`; // threshold-ok: ppm -> percent

/** Pure: the "seen" words of one mover. */
export function seenWords(x: {
  readonly picked: boolean;
  readonly families: readonly string[];
  readonly blocked: readonly string[];
}): string {
  if (x.picked) return "picked last night";
  if (x.families.length === 0) return "no strategy signalled it";
  const fams = [...new Set(x.families)].sort().join(", ");
  if (x.blocked.length > 0) {
    const why = [...new Set(x.blocked.map(blockWords))].join("; ");
    return `signalled by ${fams}, trade blocked: ${why}`;
  }
  return `signalled by ${fams}, not a pick`;
}

/** Pure: the "news" words of one mover from its announcements around the session. */
export function newsWords(
  d: string,
  anns: readonly {
    readonly publishedAt: string;
    readonly sensitive: boolean;
    readonly title: string;
  }[],
): string {
  const sens = anns.filter((a) => a.sensitive);
  const before = sens.filter((a) => {
    const s = sydneyHhmm(a.publishedAt);
    return s.d < d || (s.d === d && s.hhmm < OPEN_HHMM);
  });
  const during = sens.filter((a) => !before.includes(a) && sydneyHhmm(a.publishedAt).d === d);
  const cut = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}...` : t); // threshold-ok: line length
  if (before.length > 0) return `price-sensitive news before the open: "${cut(before[0]!.title)}"`;
  if (during.length > 0)
    return `price-sensitive news during the day (not knowable at the open): "${cut(during[0]!.title)}"`;
  if (anns.length > 0) return "only routine announcements";
  return "no announcement";
}

/** Section facts for review date c.d, or null on a non-trading day or without two sessions of bars. */
export async function readMissedMovers(c: Ctx): Promise<MissedMoversFacts | null> {
  if (!c.tradingDay) return null;
  const prev = prevSession(c.d, c.calendar);
  const moves = await c.db.execute({
    sql: `SELECT a.code, a.c AS c, b.c AS pc FROM price_bar a
          JOIN price_bar b ON b.market = a.market AND b.code = a.code AND b.d = ?
          JOIN universe_snapshot u ON u.market = a.market AND u.code = a.code
            AND u.d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
          WHERE a.market = ? AND a.d = ? AND u.status = 'active' AND u.halted = 0
            AND u.tier IN (${LIQUID_TIERS.map(() => "?").join(",")})`,
    args: [prev, c.market, c.d, c.market, c.d, ...LIQUID_TIERS],
  });
  const all = moves.rows
    .map((r) => ({ code: str(r.code), c: num(r.c), pc: num(r.pc) }))
    .filter((r) => r.pc > 0 && r.c > 0)
    .map((r) => ({ code: r.code, movePpm: Math.round(((r.c - r.pc) * PPM) / r.pc) }))
    .sort((a, b) => b.movePpm - a.movePpm || (a.code < b.code ? -1 : 1));
  if (all.length === 0) return null;
  const gainers = all.filter((m) => m.movePpm > 0).slice(0, MOVERS_LISTED);
  const losers = all
    .filter((m) => m.movePpm < 0)
    .slice(-MOVERS_LISTED)
    .reverse();
  const codes = [...new Set([...gainers, ...losers].map((m) => m.code))];

  // last night's picks (all of them, for the grading line; the movers check is by code)
  const picks = await c.db.execute({
    sql: `SELECT p.code, p.reference_micro, p.stop_micro, p.aim_micro, b.h, b.l, b.c
          FROM pick p LEFT JOIN price_bar b ON b.market = p.market AND b.code = p.code AND b.d = ?
          WHERE p.market = ? AND p.d = ? ORDER BY p.profile, p.rank`,
    args: [c.d, c.market, prev],
  });
  const picked = new Set(picks.rows.map((r) => str(r.code)));

  const marks = codes.map(() => "?").join(",");
  const sigs =
    codes.length === 0
      ? { rows: [] }
      : await c.db.execute({
          sql: `SELECT s.code, s.family, b.reason FROM signal s
                LEFT JOIN blocked_trade b ON b.signal_id = s.id
                WHERE s.market = ? AND s.d IN (?, ?) AND s.code IN (${marks})
                ORDER BY s.code, s.family`,
          args: [c.market, prev, c.d, ...codes],
        });
  const fam = new Map<string, string[]>();
  const blk = new Map<string, string[]>();
  for (const r of sigs.rows) {
    const k = str(r.code);
    fam.set(k, [...(fam.get(k) ?? []), str(r.family)]);
    if (r.reason !== null && r.reason !== undefined)
      blk.set(k, [...(blk.get(k) ?? []), str(r.reason)]);
  }
  const anns =
    codes.length === 0
      ? { rows: [] }
      : await c.db.execute({
          sql: `SELECT code, published_at, price_sensitive, title FROM announcement
                WHERE market = ? AND code IN (${marks}) AND published_at >= ? AND published_at < ?
                ORDER BY published_at`,
          args: [c.market, ...codes, `${prev}T00:00:00.000Z`, `${addDays(c.d, 1)}T13:00:00.000Z`],
        });
  const annBy = new Map<string, { publishedAt: string; sensitive: boolean; title: string }[]>();
  for (const r of anns.rows) {
    const k = str(r.code);
    annBy.set(k, [
      ...(annBy.get(k) ?? []),
      {
        publishedAt: str(r.published_at),
        sensitive: num(r.price_sensitive) === 1,
        title: str(r.title),
      },
    ]);
  }
  const famName = await familyNames(c.db);
  const cn = await companyNames(c.db, c.market, codes);
  const fact = (m: { code: string; movePpm: number }): MoverFact => ({
    code: m.code,
    name: cn.get(m.code) ?? null,
    movePpm: m.movePpm,
    seen: seenWords({
      picked: picked.has(m.code),
      families: (fam.get(m.code) ?? []).map((f) => famName[f] ?? f),
      blocked: blk.get(m.code) ?? [],
    }),
    news: newsWords(c.d, annBy.get(m.code) ?? []),
  });

  const lines: string[] = [];
  if (picks.rows.length === 0) {
    lines.push("Last night's picks: none were published, so there is nothing to grade today.");
  } else {
    let up = 0;
    let aims = 0;
    let stops = 0;
    for (const r of picks.rows) {
      if (r.c === null || r.c === undefined) continue;
      const ref = num(r.reference_micro) / PPM;
      if (num(r.c) > ref) up += 1;
      if (num(r.h) * PPM >= num(r.aim_micro)) aims += 1;
      if (num(r.l) * PPM <= num(r.stop_micro)) stops += 1;
    }
    lines.push(
      `Last night's ${picks.rows.length === 1 ? "pick" : `${picks.rows.length} picks`} today: ${up} closed above the reference price, ${aims} touched the aim, ${stops} touched the stop.`,
    );
  }
  lines.push(await trackRecordLine(c));
  const seenCount = [...gainers, ...losers].filter(
    (m) => picked.has(m.code) || (fam.get(m.code) ?? []).length > 0,
  ).length;
  lines.push(
    `Of today's ${gainers.length + losers.length} biggest movers (top gainers and losers, liquid shares), ${seenCount} were seen by a strategy or picked.`,
  );
  return { lines, gainers: gainers.map(fact), losers: losers.map(fact) };
}

const TRACK_MAX = 5000; // threshold-ok: closed pick outcomes read for the running record
const HISTORY_PCT_RE = /(\d+) % of them ended with a net gain/;

/** Pure: the running record line from closed outcomes (picks and their luck-check twins). */
export function trackRecordText(
  rows: readonly { readonly kind: string; readonly netPpm: number; readonly basedOn: string }[],
): string {
  const picks = rows.filter((r) => r.kind === "pick");
  if (picks.length === 0)
    return "Track record: no pick has closed yet, so there is no hit rate to compare.";
  const pct = (n: number, of: number) => Math.round((n * 100) / of); // threshold-ok: percent
  const won = picks.filter((r) => r.netPpm > 0).length;
  const stated = picks
    .map((r) => {
      const lines = JSON.parse(r.basedOn) as unknown;
      const hit = Array.isArray(lines)
        ? lines.map((l) => HISTORY_PCT_RE.exec(String(l))).find((m) => m !== null)
        : undefined;
      return hit ? Number(hit[1]) : null;
    })
    .filter((x): x is number => x !== null);
  const luck = rows.filter((r) => r.kind === "luck");
  const parts = [
    `Track record so far: ${picks.length} ${picks.length === 1 ? "pick" : "picks"} closed, ${won} with a net gain (${pct(won, picks.length)} %)`,
  ];
  if (stated.length > 0) {
    const avg = Math.round(stated.reduce((s, x) => s + x, 0) / stated.length);
    parts.push(`their history said ${avg} % on average`);
  }
  if (luck.length > 0) {
    const lw = luck.filter((r) => r.netPpm > 0).length;
    parts.push(`luck-check twins ${lw} of ${luck.length} (${pct(lw, luck.length)} %)`);
  }
  return `${parts.join("; ")}.`;
}

async function trackRecordLine(c: Ctx): Promise<string> {
  const r = await c.db.execute({
    sql: `SELECT o.kind, o.net_ppm, p.based_on_json FROM pick_outcome o
          JOIN pick p ON p.market = o.market AND p.d = o.d AND p.profile = o.profile AND p.rank = o.rank
          WHERE o.market = ? AND o.state = 'closed' AND o.exit_d <= ?
          ORDER BY o.d DESC LIMIT ?`,
    args: [c.market, c.d, TRACK_MAX],
  });
  return trackRecordText(
    r.rows.map((x) => ({
      kind: str(x.kind),
      netPpm: num(x.net_ppm),
      basedOn: str(x.based_on_json),
    })),
  );
}
