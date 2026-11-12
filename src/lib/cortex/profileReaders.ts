// Cortex readers of the market-profile fields that select a rule set (M19 B1, built at M20 A5; CXA-002 e, f, g, i;
// D-1003, D-1108, D-1112). AU has one reader per field (today's behaviour, unchanged); IN and US select the readers
// built at M20 by the VALUE of the profile field (the scheme, the halt model, the map kind), never by a market code. A
// value with no reader still throws `not built (M20): ...` (the stub class stays for any later market), so a profile
// that names an unknown rule set can never run a night on the AU rules by accident (PRD-039). Pure except
// `writeAnnouncementCategory`, the one writer of `announcement_category` (the market's batch 1 calls it; never an LLM,
// AGT-011a).
import type { Client } from "@libsql/client";
import type { MarketProfile } from "@/lib/market/profileCore.mjs";
import { homeProfile } from "@/lib/market/staticProfile.mjs";
import {
  CATEGORY_KIND as IN_CATEGORY_KIND,
  CATEGORY_MAP as IN_CATEGORY_MAP,
} from "@/lib/market/seed/in/categoryMap.mjs";
import {
  CATEGORY_KIND as US_CATEGORY_KIND,
  CATEGORY_MAP as US_CATEGORY_MAP,
} from "@/lib/market/seed/us/categoryMap.mjs";

/** Thrown by a reader for a rule set that is not built (the message starts `not built (M20)`). */
export class NotBuiltM20 extends Error {
  constructor(what: string, value: string | null) {
    super(`not built (M20): ${what} ${value ?? "null"}`);
    this.name = "NotBuiltM20";
  }
}

// ---- (e) classification: the group the per-industry NAV cap and the sector angles use --------------------------

/** The fields of an `instrument` row a classification reader reads (`sic` is the EDGAR SIC code, text or number). */
export type InstrumentClassRow = {
  readonly industry?: string | null;
  readonly sic?: string | number | null;
};

/** D-1112: the scheme name and the function that maps an instrument row to its industry group (null = unknown). */
export type ClassificationReader = {
  readonly scheme: string;
  groupOf(row: InstrumentClassRow): string | null;
};

const HOME_SCHEME: string = homeProfile().classificationScheme!;

const industryColumn = (row: InstrumentClassRow): string | null => {
  const v = row.industry;
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};

/** The first two digits of a four-digit SIC code (`7372` -> `73`); a short numeric code is zero-padded; else null. */
export function sicTwoDigit(sic: string | number | null | undefined): string | null {
  if (sic === undefined || sic === null) return null;
  const t = String(sic).trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return t.padStart(4, "0").slice(0, 2);
}

/** A stored two-digit SIC group (`73`), as the US submissions job writes it into `instrument.industry` (M20 US1, D-1182). */
function storedSicGroup(industry: string | null | undefined): string | null {
  if (industry === undefined || industry === null) return null;
  const t = String(industry).trim();
  return /^d{2}$/.test(t) ? t : null;
}

const CLASSIFICATION_READERS: Readonly<Record<string, ClassificationReader>> = Object.freeze({
  // the home scheme and the NSE level-2 string both read `instrument.industry` (D-1112)
  [HOME_SCHEME]: Object.freeze({ scheme: HOME_SCHEME, groupOf: industryColumn }),
  nse_level2: Object.freeze({ scheme: "nse_level2", groupOf: industryColumn }),
  sic_2digit: Object.freeze({
    scheme: "sic_2digit",
    groupOf: (r: InstrumentClassRow) => sicTwoDigit(r.sic) ?? storedSicGroup(r.industry),
  }),
});

export function classificationReader(profile: MarketProfile): ClassificationReader {
  const scheme = profile.classificationScheme;
  const reader = scheme === null ? undefined : CLASSIFICATION_READERS[scheme];
  if (
    reader !== undefined &&
    Object.prototype.hasOwnProperty.call(CLASSIFICATION_READERS, scheme!)
  ) {
    return reader;
  }
  throw new NotBuiltM20("classification scheme", scheme);
}

// ---- (f) halts ---------------------------------------------------------------------------------------------------

/** The halt and suspension rule set of `cortex/states/*` and `arena/corpActions.ts` (D-1109, D-1110). */
export type HaltReader = "cx16" | "in_bands" | "us_luld";
const HALT_READERS: readonly HaltReader[] = ["cx16", "in_bands", "us_luld"];

export function haltReader(profile: MarketProfile): HaltReader {
  const m = profile.haltModel;
  const found = HALT_READERS.find((h) => h === m);
  if (found !== undefined) return found;
  throw new NotBuiltM20("halt model", m);
}

// ---- (g) the announcement category map -------------------------------------------------------------------------

/** The 11 AGT-020 categories of DAT-245 (the `announcement_category.category` and `label_item.label` values). */
export const ANNOUNCEMENT_CATEGORIES = [
  "results",
  "guidance",
  "contract",
  "capital_raising",
  "director_trade",
  "substantial_holder",
  "takeover",
  "halt",
  "exchange_query",
  "dividend",
  "other",
] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export type CategoryMatch = {
  readonly type?: string;
  readonly item?: string;
  readonly form?: string;
  readonly title_re?: string;
};
export type CategoryRow = {
  readonly match: CategoryMatch;
  readonly category: string;
  readonly materiality: 0 | 1 | 2 | 3;
  readonly verifiable: boolean;
  readonly materiality_disclosed?: 0 | 1 | 2 | 3;
};
export type CategoryMap = { readonly version: string; readonly rows: readonly CategoryRow[] };

/** The category maps by the `category_map` field kind of a profile. */
const CATEGORY_MAPS: Readonly<Record<string, CategoryMap>> = Object.freeze({
  [IN_CATEGORY_KIND]: IN_CATEGORY_MAP,
  [US_CATEGORY_KIND]: US_CATEGORY_MAP,
});

/**
 * (g) The price-sensitive category map. `{ kind: "none" }` is the AU path (the ASX feed carries the flag, no
 * map: null); a kind with a map returns the table; any other value is not built.
 */
export function categoryMapReader(profile: MarketProfile): CategoryMap | null {
  const v = profile.fields.category_map?.value;
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (kind === "none") return null;
  if (typeof kind === "string" && Object.prototype.hasOwnProperty.call(CATEGORY_MAPS, kind)) {
    return CATEGORY_MAPS[kind]!;
  }
  throw new NotBuiltM20("category map", v === undefined || v === null ? null : JSON.stringify(v));
}

/** What the classifier knows about one announcement or filing (the source's own words; never a body, D-1125). */
export type AnnouncementItem = {
  /** NSE/BSE subject, or the source type (`trading_halt`). */
  readonly type?: string | null;
  /** The 8-K item number(s), e.g. `"2.02"` or `["2.02", "9.01"]`. */
  readonly item?: string | readonly string[] | null;
  /** The EDGAR form type (`10-Q`, `4`, `SC 13D`). */
  readonly form?: string | null;
  readonly title?: string | null;
  /** The evidence CTX-043 asks for, set by the batch that parsed the item. */
  readonly facts?: {
    readonly statementsParsed?: boolean;
    readonly valueDisclosed?: boolean;
    readonly counterpartyDisclosed?: boolean;
  };
};

export type Classified = {
  readonly category: string;
  readonly materiality: 0 | 1 | 2 | 3;
  readonly verifiable: boolean;
  readonly mapVersion: string;
  /** The index of the first matching row (for the tests and the journal). */
  readonly rule: number;
};

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const reCache = new Map<string, RegExp>();
function re(source: string): RegExp {
  let r = reCache.get(source);
  if (r === undefined) {
    r = new RegExp(source, "i");
    reCache.set(source, r);
  }
  return r;
}

function matches(m: CategoryMatch, it: AnnouncementItem): boolean {
  if (m.type !== undefined && !norm(it.type).includes(norm(m.type))) return false;
  if (m.item !== undefined) {
    const items = it.item === undefined || it.item === null ? [] : [it.item].flat();
    if (!items.some((i) => norm(i) === norm(m.item))) return false;
  }
  if (m.form !== undefined && norm(it.form) !== norm(m.form)) return false;
  if (m.title_re !== undefined && !re(m.title_re).test(it.title ?? "")) return false;
  return true;
}

/**
 * Pure and first-match (D-1108): the category, the AGT-011 materiality and whether the item is verifiable (CTX-043).
 * A row marked `verifiable` is eligible; the item must carry the evidence: results and guidance need parsed
 * statements, a contract needs a disclosed value and counterparty (which also lifts it to `materiality_disclosed`).
 */
export function classify(map: CategoryMap, item: AnnouncementItem): Classified {
  const rule = map.rows.findIndex((r) => matches(r.match, item));
  if (rule < 0) throw new RangeError(`category map ${map.version} has no catch-all row`);
  const row = map.rows[rule]!;
  const f = item.facts ?? {};
  const disclosed = f.valueDisclosed === true && f.counterpartyDisclosed === true;
  let verifiable = false;
  if (row.verifiable) {
    verifiable = row.category === "contract" ? disclosed : f.statementsParsed === true;
  }
  const materiality =
    row.category === "contract" && disclosed && row.materiality_disclosed !== undefined
      ? row.materiality_disclosed
      : row.materiality;
  return { category: row.category, materiality, verifiable, mapVersion: map.version, rule };
}

/**
 * The one writer of `announcement_category` (D-1108): the market's batch 1 calls it for each new announcement, after
 * `assertMarketEnabled`. The first classification of an announcement stays (a later map version is a new run over
 * the day, not an overwrite). Returns the FRESH classification of this call, which on a repeat may differ from the stored row (read the table for the stored one).
 */
export async function writeAnnouncementCategory(
  db: Pick<Client, "execute">,
  key: { readonly market: string; readonly source: string; readonly annId: string },
  map: CategoryMap,
  item: AnnouncementItem,
): Promise<Classified> {
  const c = classify(map, item);
  await db.execute({
    // rows-ok: one insert keyed by the primary key (market, source, ann_id), once per new announcement
    sql: `INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (market, source, ann_id) DO NOTHING`,
    args: [
      key.market,
      key.source,
      key.annId,
      c.category,
      c.materiality,
      c.verifiable ? 1 : 0,
      c.mapVersion,
    ],
  });
  return c;
}

export type ProfileReaders = {
  readonly classification: ClassificationReader;
  readonly halt: HaltReader;
  readonly categoryMap: CategoryMap | null;
};

/** The three rule-set readers of a profile, or the first unbuilt reader's error. */
export function profileReaders(profile: MarketProfile): ProfileReaders {
  return {
    classification: classificationReader(profile),
    halt: haltReader(profile),
    categoryMap: categoryMapReader(profile),
  };
}

/** The franking angle (A-D4-05): skipped for a market with no dividend imputation (CXA-002 i). */
export const FRANKING_ANGLE_ID = "A-D4-05";

/** The angle definitions a market runs: every angle, less the franking angle without imputation. */
export function anglesForProfile<T extends { readonly id: string }>(
  angles: readonly T[],
  profile: MarketProfile,
): readonly T[] {
  return profile.dividendImputation === true
    ? angles
    : angles.filter((a) => a.id !== FRANKING_ANGLE_ID);
}
