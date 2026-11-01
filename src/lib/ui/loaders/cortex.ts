// Cortex page loader (M15 P4; CTX-071, CTX-072, CTX-073, ROL-107, D-277, D-295). Reads the 0019 tables
// through the store (src/lib/cortex/store) and returns a plain, serialisable, already masked view
// model. Nothing is computed in the request except small sums and the luck figure (D-277: computed,
// never typed in). Every figure that has no stored source says "Not measured yet" (null here).
//
// Masking (ROL-107, unchanged): a masked viewer's model holds no family code, angle id, book id or
// money amount; strategies, angles and books are numbered instead. The Owner sees names and amounts.
//
// Data contracts the offline import and the P6 evaluator write (D-347, recorded in the P4 report):
//   family_status.evidence_json   { n_eff?: number, mde?: number }       (mde = fraction of a trade)
//   cortex_ledger_cell kind 'placebo'      result { passed: boolean, null_pass_rate: number }
//   cortex_ledger_cell kind 'nav_at_risk'  result { loss_95_pct: number, loss_worst_pct: number }
import "server-only";
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import {
  CORTEX_FAMILIES,
  decisionsForNight,
  familyStatusMap,
  latestMaps,
  latestPassports,
  latestStatement,
  recentNights,
  refitPending,
  type CortexFamily,
  type FamilyStatusWord,
} from "@/lib/cortex/store";
import { tickCostRow, LIQUIDITY_TIERS } from "@/lib/cortex/economics/cost";
import { FAMILY_WORD, CLUSTER_WORD } from "@/lib/cortex/phrases";
import { isoWeek, MISSING } from "@/lib/view/format";
import {
  loaded,
  money,
  num,
  openViewer,
  soft,
  str,
  type Loaded,
  type LoaderDeps,
  type Money,
} from "./common";

/** D-295: the label that tells a reader these books settle like live ones. */
export const LIVE_BOOKS_LABEL = "Live books, matched settlement";
export const NOT_MEASURED = "Not measured yet";
export const SHADOW_ONLY_TEXT =
  "No map is loaded yet, so every strategy runs in shadow only: nothing is bought, results are recorded.";

const WINDOW_DAYS = 60; // threshold-ok: look-back of the abstain and comparator figures
const MAX_PASSPORTS = 80; // threshold-ok: passport rows listed
const MAX_NIGHTS = 400; // threshold-ok: nights read for the cold-start count
const DEFAULT_FDR_Q = 0.1; // threshold-ok: registry default of ledger_fdr_q
const PPM = 1_000_000; // threshold-ok: parts per million
const MS_DAY = 86_400_000; // threshold-ok: milliseconds per day
const TICK_PRICES_CENTS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000] as const; // threshold-ok: display prices
const CENTS_TO_MICRO = 10_000n; // threshold-ok: micro per cent
const NAV_LOSS_KEYS = ["loss_95_pct", "loss_worst_pct"] as const;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---- Melbourne time (CTX-073) ------------------------------------------------------------------------

const MELBOURNE = "Australia/Melbourne";
const OFFSET_RE = /GMT([+-]\d+)(?::(\d+))?/;

/** "Sat 31 Oct 2026, 8:15 pm AEDT (UTC+11)": Melbourne time with the offset of that instant, never UTC. */
export function melbourneStamp(iso: string | null): string | null {
  if (iso === null) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const when = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(t);
  const tz = new Intl.DateTimeFormat("en-AU", { timeZone: MELBOURNE, timeZoneName: "longOffset" })
    .formatToParts(t)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = tz === undefined ? null : OFFSET_RE.exec(tz);
  const hours = m === null ? 10 : Number(m[1]); // threshold-ok: AEST fallback
  const name = hours === 11 ? "AEDT" : "AEST"; // threshold-ok: Melbourne daylight offset
  return `${when} ${name} (UTC${hours >= 0 ? "+" : ""}${hours})`;
}

// ---- view model ------------------------------------------------------------------------------------------

export type PassportView = {
  angle: string;
  cluster: string;
  status: string;
  horizonSessions: number;
};
export type FamilyView = {
  /** "F1 trend breakout" for the Owner, "Strategy 1" for a masked viewer. */
  name: string;
  status: FamilyStatusWord;
  sinceD: string;
  setBy: string;
  nEff: number | null;
  mde: number | null;
  statement: string | null;
  mapFitted: string | null;
};
export type AbstainReason = { label: string; count: number };
export type TickRowView = {
  priceMicro: number;
  tickMicro: number;
  halfSpreadPpm: Record<string, number>;
};
export type OpinionView = { kind: string; total: number; settled: number };

export type CortexView = {
  role: string | null;
  masked: boolean;
  liveBooksLabel: string;
  asOf: string | null;
  asOfMelbourne: string | null;
  mapsLoaded: number;
  shadowOnly: boolean;
  shadowOnlyText: string;
  refitPending: boolean;
  passports: { total: number; byStatus: Record<string, number>; rows: PassportView[] };
  ledger: {
    cells: number;
    keyEdits: number;
    level: number;
    luckExpected: number;
    luckText: string;
  };
  families: FamilyView[];
  placebo: { passed: boolean; nullPassRatePpm: number | null; at: string | null } | null;
  navAtRisk: { loss95Pct: number | null; lossWorstPct: number | null; at: string | null } | null;
  abstains: {
    nights: number;
    total: number;
    reasons: AbstainReason[];
    shadowFilled: number;
    shadowMeanNet: Money | null;
    shadowTotalNet: Money | null;
    idleSharePpm: number | null;
  };
  sectorTilt: { d: string; rows: { book: string; sector: string; tiltPp: number }[] } | null;
  coldStart: { nights: number; firstD: string | null; lastD: string | null; warming: boolean };
  opinions: OpinionView[];
  tickCost: TickRowView[];
  /** Owner controls (CTX-072): the page links to the existing writers, it has no writer of its own. */
  controls: { canEdit: boolean; configHref: string; killHref: string };
};

// ---- reads -----------------------------------------------------------------------------------------------

const dayMinus = (d: string, days: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) - days * MS_DAY).toISOString().slice(0, 10);

async function count(db: Client, sql: string, args: (string | number)[]): Promise<number> {
  const r = await db.execute({ sql, args });
  return num(r.rows[0]?.n ?? 0);
}

async function newestResult(
  db: Client,
  market: string,
  kind: string,
): Promise<{ result: Record<string, unknown>; at: string } | null> {
  const r = await db.execute({
    sql: `SELECT result_json, result_at FROM cortex_ledger_cell
          WHERE market = ? AND kind = ? AND result_at IS NOT NULL
          ORDER BY result_at DESC, cell_id DESC LIMIT 1`,
    args: [market, kind],
  });
  const row = r.rows[0];
  if (!row) return null;
  const result = obj(JSON.parse(str(row.result_json)));
  return result === null ? null : { result, at: str(row.result_at) };
}

const EMPTY_ABSTAINS: CortexView["abstains"] = {
  nights: 0,
  total: 0,
  reasons: [],
  shadowFilled: 0,
  shadowMeanNet: null,
  shadowTotalNet: null,
  idleSharePpm: null,
};

export async function loadCortex(deps: LoaderDeps): Promise<Loaded<CortexView>> {
  const v = await openViewer(deps);
  const db = deps.mainDb;
  const market = v.market;
  const masked = v.masker.masked;
  const role = deps.user?.role ?? null;

  const nights = await soft(() => recentNights(db, market, "9999-12-31", MAX_NIGHTS), []);
  const lastD = nights[0]?.d ?? null;
  const firstD = nights.length > 0 ? nights[nights.length - 1]!.d : null;
  // A masked viewer sees ISO weeks, never an exact date (UX-009, D-175).
  const weekOf = (d: string): string => `week ${isoWeek(d.slice(0, 10)) ?? MISSING}`;
  const stampOf = (iso: string | null): string | null =>
    masked && iso !== null ? weekOf(iso) : melbourneStamp(iso);
  const asOfIso = lastD === null ? null : `${lastD}T00:00:00Z`;
  const since = lastD === null ? "0000-00-00" : dayMinus(lastD, WINDOW_DAYS);

  const maps = await soft(() => latestMaps(db, market), []);
  const mapFamilies = new Map<CortexFamily, string>();
  for (const m of maps) {
    const cur = mapFamilies.get(m.family);
    if (cur === undefined || m.fittedAt > cur) mapFamilies.set(m.family, m.fittedAt);
  }

  // passports
  const passports = await soft(() => latestPassports(db, market), []);
  const byStatus: Record<string, number> = {};
  for (const p of passports) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const passportRows: PassportView[] = passports.slice(0, MAX_PASSPORTS).map((p, i) => ({
    angle: masked ? `Angle ${i + 1}` : p.angleId,
    cluster: CLUSTER_WORD[p.cluster] ?? p.cluster,
    status: p.status,
    horizonSessions: p.horizonSessions,
  }));

  // ledger count and the luck figure (D-277): cells tried x the false-discovery level
  const cells = await soft(
    () =>
      count(
        db,
        "SELECT COUNT(*) AS n FROM cortex_ledger_cell WHERE market = ? AND kind <> 'key_edit'",
        [market],
      ),
    0,
  );
  const keyEdits = await soft(
    () =>
      count(
        db,
        "SELECT COUNT(*) AS n FROM cortex_ledger_cell WHERE market = ? AND kind = 'key_edit'",
        [market],
      ),
    0,
  );
  const q = fin(await soft(() => getConfig(db, "ledger_fdr_q"), DEFAULT_FDR_Q)) ?? DEFAULT_FDR_Q;
  const tried = cells + keyEdits;
  const luckExpected = Math.round(tried * q * 10) / 10; // threshold-ok: one decimal
  const luckText =
    tried === 0
      ? NOT_MEASURED
      : `Of ${tried} ideas tried, about ${luckExpected} would look good by luck alone.`;

  // family status, numbers and MDEs
  const status = await soft(
    () => familyStatusMap(db, market, lastD ?? "9999-12-31"),
    null as Record<CortexFamily, FamilyStatusWord> | null,
  );
  const rows = await soft(
    async () =>
      (
        await db.execute({
          sql: `SELECT s.family, s.since_d, s.status, s.evidence_json, s.set_by FROM family_status s
                WHERE s.market = ? AND s.since_d = (SELECT MAX(x.since_d) FROM family_status x
                  WHERE x.market = s.market AND x.family = s.family)`,
          args: [market],
        })
      ).rows,
    [],
  );
  const byFamily = new Map(rows.map((r) => [str(r.family), r]));
  const families: FamilyView[] = [];
  for (const [i, f] of CORTEX_FAMILIES.entries()) {
    const r = byFamily.get(f);
    const ev = r ? obj(safeParse(r.evidence_json)) : null;
    const st = await soft(() => latestStatement(db, market, f), null);
    families.push({
      name: masked ? `Strategy ${i + 1}` : `${f} ${FAMILY_WORD[f] ?? ""}`.trim(),
      status: status?.[f] ?? "shadow",
      sinceD: r ? str(r.since_d) : "",
      setBy: r ? str(r.set_by) : "import",
      nEff: fin(ev?.n_eff),
      mde: fin(ev?.mde),
      statement: masked ? null : (st?.text ?? null),
      mapFitted: mapFamilies.get(f) ?? null,
    });
  }

  // placebo and NAV-at-risk
  const placeboRow = await soft(() => newestResult(db, market, "placebo"), null);
  const placebo =
    placeboRow === null || typeof placeboRow.result.passed !== "boolean"
      ? null
      : {
          passed: placeboRow.result.passed,
          nullPassRatePpm:
            fin(placeboRow.result.null_pass_rate) === null
              ? null
              : Math.round((fin(placeboRow.result.null_pass_rate) ?? 0) * PPM),
          at: stampOf(placeboRow.at),
        };
  const navRow = await soft(() => newestResult(db, market, "nav_at_risk"), null);
  const navAtRisk =
    navRow === null
      ? null
      : {
          loss95Pct: fin(navRow.result[NAV_LOSS_KEYS[0]]),
          lossWorstPct: fin(navRow.result[NAV_LOSS_KEYS[1]]),
          at: stampOf(navRow.at),
        };

  // abstentions by reason, shadow comparator, cash drag
  let abstains = EMPTY_ABSTAINS;
  if (lastD !== null) {
    abstains = await soft(async () => {
      const ab = await db.execute({
        sql: `SELECT label, COUNT(*) AS n FROM cortex_abstain WHERE market = ? AND d >= ?
              GROUP BY label ORDER BY n DESC, label`,
        args: [market, since],
      });
      const reasons = ab.rows.map((r) => ({ label: str(r.label), count: num(r.n) }));
      const total = reasons.reduce((s, r) => s + r.count, 0);
      const sh = await db.execute({
        sql: `SELECT COUNT(*) AS n, COALESCE(SUM(net_micro), 0) AS net FROM cortex_outcome
              WHERE market = ? AND arm = 'shadow' AND fill_status = 'filled' AND net_micro IS NOT NULL
                AND d >= ?`,
        args: [market, since],
      });
      const n = num(sh.rows[0]?.n ?? 0);
      const net = num(sh.rows[0]?.net ?? 0);
      const bookNights = await count(
        db,
        "SELECT COUNT(*) AS n FROM (SELECT DISTINCT d, book_id FROM cortex_decision WHERE market = ? AND d >= ?)",
        [market, since],
      );
      const nightsInWindow = await count(
        db,
        "SELECT COUNT(*) AS n FROM cortex_night WHERE market = ? AND d >= ?",
        [market, since],
      );
      return {
        nights: nightsInWindow,
        total,
        reasons,
        shadowFilled: n,
        shadowMeanNet: masked || n === 0 ? null : money(Math.round(net / n)),
        shadowTotalNet: masked || n === 0 ? null : money(net),
        idleSharePpm:
          total + bookNights === 0 ? null : Math.round((total / (total + bookNights)) * PPM),
      };
    }, EMPTY_ABSTAINS);
  }

  // sector tilt (shadow): the newest night that has one
  const sectorTilt = await soft(async () => {
    if (lastD === null) return null;
    const r = await db.execute({
      sql: `SELECT d FROM cortex_decision WHERE market = ? AND sector_tilt_json IS NOT NULL
            ORDER BY d DESC LIMIT 1`,
      args: [market],
    });
    const d = r.rows[0] ? str(r.rows[0].d) : null;
    if (d === null) return null;
    const out: { book: string; sector: string; tiltPp: number }[] = [];
    const books = new Map<string, number>();
    for (const x of await decisionsForNight(db, market, d, { arm: "shadow" })) {
      const t = obj(x.sectorTilt);
      const sector = typeof t?.sector === "string" ? t.sector : null;
      const tilt = fin(t?.tiltPp);
      if (sector === null || tilt === null) continue;
      if (!books.has(x.bookId)) books.set(x.bookId, books.size + 1);
      out.push({
        book: masked ? `Book ${books.get(x.bookId)}` : x.bookId,
        sector,
        tiltPp: tilt,
      });
    }
    return out.length === 0 ? null : { d, rows: out };
  }, null);

  // opinion track (hook only)
  const opinions = await soft(async () => {
    const r = await db.execute({
      sql: `SELECT kind, COUNT(*) AS n, SUM(CASE WHEN settled_d IS NULL THEN 0 ELSE 1 END) AS s
            FROM opinion_track WHERE market = ? GROUP BY kind ORDER BY kind`,
      args: [market],
    });
    return r.rows.map((x) => ({ kind: str(x.kind), total: num(x.n), settled: num(x.s) }));
  }, [] as OpinionView[]);

  const tickCost: TickRowView[] = TICK_PRICES_CENTS.map((c) => {
    const row = tickCostRow(BigInt(c) * CENTS_TO_MICRO);
    return {
      priceMicro: Number(row.priceMicro),
      tickMicro: Number(row.tickMicro),
      halfSpreadPpm: Object.fromEntries(LIQUIDITY_TIERS.map((t) => [t, row.halfSpreadPpm[t]])),
    };
  });

  const mapsLoaded = mapFamilies.size;
  const pending = await soft(() => refitPending(db, market), false);
  const view: CortexView = {
    role,
    masked,
    liveBooksLabel: LIVE_BOOKS_LABEL,
    asOf: lastD,
    asOfMelbourne: stampOf(asOfIso),
    mapsLoaded,
    shadowOnly: mapsLoaded === 0,
    shadowOnlyText: SHADOW_ONLY_TEXT,
    refitPending: pending,
    passports: { total: passports.length, byStatus, rows: passportRows },
    ledger: { cells, keyEdits, level: q, luckExpected, luckText },
    families,
    placebo,
    navAtRisk,
    abstains,
    sectorTilt,
    coldStart: {
      nights: nights.length,
      firstD: masked && firstD !== null ? weekOf(firstD) : firstD,
      lastD: masked && lastD !== null ? weekOf(lastD) : lastD,
      warming: mapsLoaded === 0,
    },
    opinions,
    tickCost,
    controls: {
      canEdit: role === "owner",
      configHref: "/config",
      killHref: "/strategies/risk",
    },
  };
  const page = loaded(lastD, v.now, masked, view, "Cortex has not run yet.");
  // The stale note names the newest night: a masked viewer gets its ISO week (D-175).
  if (masked && page.state === "stale" && lastD !== null) {
    page.text = `Showing data from ${weekOf(lastD)}. It has not updated since.`;
  }
  return page;
}

function safeParse(s: unknown): unknown {
  try {
    return JSON.parse(str(s));
  } catch {
    return null;
  }
}
