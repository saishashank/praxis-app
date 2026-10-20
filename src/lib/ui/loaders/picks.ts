// Picks loaders: the profile page, "Why this pick" and the track record (UXN-040..045, ARN-095;
// docs/M7_design.md 3 rows 5..7; D-136 draft). Stored, published numbers only. A masked user (UX-009,
// DAT-124) gets "Stock A" for the code, no company name, no prices, the ISO week instead of exact
// dates and masked free text; the figures that carry no price (probabilities, counts) stay.
import { getConfig } from "@/lib/config/store";
import { modelSuccess, successLine, type ModelSuccess } from "@/lib/picks/success";
import { formatPpm, isoWeek, MISSING } from "@/lib/view/format";
import { dateStaleness } from "@/lib/view/staleness";
import { maskText } from "@/lib/view/mask";
import { createHash } from "node:crypto";
import { soft, strategyNames } from "./common";
import { cardHref } from "./cards";
import {
  isDateParam,
  marketOf,
  maskKit,
  maskKitByDate,
  money,
  todayD,
  type LoaderEnv,
  type LoaderState,
  type MoneyView,
} from "./shell";

const STALE_DAYS = 4; // threshold-ok: nightly picks; a long weekend is 3 days, one more is late
const TRACK_ROWS = 200; // threshold-ok: bounded list, newest first
const DEFAULT_PROFILE = "balanced";
const PROFILE_RE = /^[a-z][a-z_]{0,23}$/;
const PK_RE = /^pk:([0-9a-f]{16})$/;
const HEX_LENGTH = 16; // threshold-ok: key digest length
const MAX_REF_ROWS = 5000; // threshold-ok: bound of the reference resolve scan
const ID_RE = /^(\d{4}-\d{2}-\d{2})\.([a-z][a-z_]{0,23})\.(\d{1,2})$/;

/** `pk:` plus 16 hex of SHA-256 of the readable id (date.profile.rank). */
export const pickRef = (realId: string): string =>
  "pk:" + createHash("sha256").update(realId).digest("hex").slice(0, HEX_LENGTH);

/** The id shown in links: readable for an unmasked viewer, opaque for a masked one (no date in the URL). */
const publicPickId = (realId: string, masked: boolean): string =>
  masked ? pickRef(realId) : realId;

async function resolvePickRef(env: LoaderEnv, ref: string): Promise<string | null> {
  const r = await env.main.execute({
    sql: "SELECT d, profile, rank FROM pick WHERE market = ? ORDER BY d DESC, profile, rank LIMIT ?",
    args: [marketOf(env), MAX_REF_ROWS],
  });
  for (const x of r.rows) {
    const real = `${String(x.d)}.${String(x.profile)}.${Number(x.rank)}`; // money-float-ok: SQL integer column
    if (pickRef(real) === ref) return real;
  }
  return null;
}

export type PicksQuery = { profile: string; d?: string };

async function profileNames(env: LoaderEnv): Promise<string[]> {
  try {
    const v = await getConfig(env.main, "pick_profiles");
    if (typeof v === "object" && v !== null) return Object.keys(v).sort();
  } catch {
    // fall through
  }
  return [DEFAULT_PROFILE];
}

/** `?profile=&d=`: null when a value is not allowed (unknown profile, malformed date). */
export async function parsePicksQuery(
  env: LoaderEnv,
  sp: URLSearchParams,
): Promise<PicksQuery | null> {
  const names = await profileNames(env);
  const profile =
    sp.get("profile") ?? (names.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : names[0]!);
  if (!PROFILE_RE.test(profile) || !names.includes(profile)) return null;
  const d = sp.get("d");
  if (d !== null && d !== "" && !isDateParam(d)) return null;
  return { profile, d: d || undefined };
}

/** Level against the reference price in ppm: exact integer arithmetic, rounded half away from zero. */
function ppmOf(level: unknown, reference: unknown): number | null {
  try {
    const ref = BigInt(String(reference));
    if (ref <= 0n) return null;
    const diff = (BigInt(String(level)) - ref) * 1_000_000n; // threshold-ok: ppm
    const half = ref / 2n;
    return Number(diff >= 0n ? (diff + half) / ref : -((-diff + half) / ref)); // money-float-ok: small ppm integer
  } catch {
    return null;
  }
}

/** Where a closed result sits against the range published with the pick (UXN-043). */
export function rangePosition(
  netPpm: number | null,
  badPpm: number | null,
  goodPpm: number | null,
): "inside" | "below" | "above" | null {
  if (netPpm === null || badPpm === null || goodPpm === null) return null;
  return netPpm < badPpm ? "below" : netPpm > goodPpm ? "above" : "inside";
}

export type PickRowView = {
  id: string;
  rank: number;
  /** Friendly strategy name of the family (UXN-039), or the family code when no name is stored. */
  familyName: string;
  /** Stop and aim as ppm of the reference price (the "-8%" and "+10%" of UXN-040). */
  stopPpm: number | null;
  aimPpm: number | null;
  /** Suggested size and the loss if the stop is hit (before fees); null for a masked user. */
  size: MoneyView | null;
  riskAtStop: MoneyView | null;
  /** Tracked state of the pick (UXN-043); null before tracking starts. */
  outcome: {
    state: string;
    entry: MoneyView | null;
    exitReason: string | null;
    netPpm: number | null;
  } | null;
  /** The code, or "Stock A" for a masked user. */
  stock: string;
  company: string | null;
  family: string;
  tier: string;
  label: string;
  buyUpTo: MoneyView | null;
  stop: MoneyView | null;
  aim: MoneyView | null;
  validUntil: string;
  /** Bad / typical / good case as ppm of the entry price; null = not enough similar cases. */
  scenario: { badPpm: number; typicalPpm: number; goodPpm: number; n: number } | null;
  aimReachPpm: number | null;
  timeFrameSessions: number | null;
  basedOn: string[];
  /** Link to the Decision Card; opaque `ck:` reference for a masked user. */
  cardHref: string | null;
};

export type PicksModel = {
  state: LoaderState;
  masked: boolean;
  profile: string;
  profiles: string[];
  /** Publication date shown (exact for the Owner, ISO week for a masked user). */
  d: string | null;
  staleText: string | null;
  success: (ModelSuccess & { line: string }) | null;
  picks: PickRowView[];
};

async function successFor(env: LoaderEnv, profile: string, d: string) {
  const minN = Number(await getConfig(env.main, "pick_success_min_n"));
  const confidence = Number(await getConfig(env.main, "cif_confidence"));
  const s = await modelSuccess(env.main, { market: marketOf(env), profile, d, minN, confidence });
  // The "since" date is a trade date: a masked user sees the week (UX-009). The line has a short date.
  if (env.mask.masked) {
    return {
      ...s,
      since: s.since === null ? null : (isoWeek(s.since) ?? MISSING),
      line: successLine({ ...s, since: null }),
    };
  }
  return { ...s, line: successLine(s) };
}

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v)); // money-float-ok: SQL integer column
const parseList = (json: unknown): string[] => {
  try {
    const v: unknown = JSON.parse(String(json));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** Every pick code of a date (all profiles): they join the active set so letters match across pages. */
async function pickCodes(env: LoaderEnv, d: string): Promise<string[]> {
  const r = await env.main.execute({
    sql: "SELECT DISTINCT code FROM pick WHERE market = ? AND d = ?",
    args: [marketOf(env), d],
  });
  return r.rows.map((x) => String(x.code));
}

async function pickCodesInRange(
  env: LoaderEnv,
  rows: ReadonlyArray<{ d: string }>,
): Promise<Array<{ d: string; code: string }>> {
  if (rows.length === 0) return [];
  const ds = rows.map((x) => x.d).sort();
  const r = await env.main.execute({
    sql: "SELECT DISTINCT d, code FROM pick WHERE market = ? AND d >= ? AND d <= ?",
    args: [marketOf(env), ds[0]!, ds[ds.length - 1]!],
  });
  return r.rows.map((x) => ({ d: String(x.d), code: String(x.code) }));
}

export async function loadPicks(env: LoaderEnv, q: PicksQuery): Promise<PicksModel> {
  const market = marketOf(env);
  const profiles = await profileNames(env);
  const latest = await env.main.execute({
    sql: "SELECT MAX(d) AS d FROM pick WHERE market = ? AND profile = ? AND d <= ?",
    args: [market, q.profile, q.d ?? "9999-12-31"],
  });
  const d = latest.rows[0]?.d ? String(latest.rows[0].d) : null;
  const base: PicksModel = {
    state: "empty",
    masked: env.mask.masked,
    profile: q.profile,
    profiles,
    d: null,
    staleText: null,
    success: null,
    picks: [],
  };
  if (d === null) return base;
  const rows = await env.main.execute({
    sql: `SELECT p.rank, p.code, p.family, p.tier, p.label, p.buy_max_micro, p.stop_micro, p.aim_micro,
                 p.valid_until_d, p.bad_ppm, p.typical_ppm, p.good_ppm, p.n_similar, p.aim_reach_ppm,
                 p.time_frame_sessions, p.based_on_json, p.card_id, i.name, p.reference_micro,
                 p.size_micro, p.risk_micro, o.state AS o_state, o.entry_micro AS o_entry,
                 o.exit_reason AS o_reason, o.net_ppm AS o_net
          FROM pick p LEFT JOIN instrument i ON i.market = p.market AND i.code = p.code
            LEFT JOIN pick_outcome o ON o.market = p.market AND o.d = p.d AND o.profile = p.profile
              AND o.rank = p.rank AND o.kind = 'pick'
          WHERE p.market = ? AND p.d = ? AND p.profile = ? ORDER BY p.rank LIMIT 10`,
    args: [market, d, q.profile],
  });
  const masked = env.mask.masked;
  const kit = masked ? await maskKit(env, d, await pickCodes(env, d)) : null;
  const t = (s: string): string => (kit ? maskText(s, kit.aliases, kit.lookup) : s);
  const names = await soft(() => strategyNames(env.main), {});
  const picks: PickRowView[] = rows.rows.map((x) => {
    const code = String(x.code);
    const scenario =
      x.bad_ppm === null || x.typical_ppm === null || x.good_ppm === null
        ? null
        : {
            badPpm: Number(x.bad_ppm),
            typicalPpm: Number(x.typical_ppm),
            goodPpm: Number(x.good_ppm),
            n: Number(x.n_similar),
          }; // money-float-ok: SQL integer columns
    const valid = String(x.valid_until_d);
    return {
      id: publicPickId(`${d}.${q.profile}.${Number(x.rank)}`, masked),
      rank: Number(x.rank), // money-float-ok: SQL integer column
      familyName: names[String(x.family)]?.name ?? String(x.family),
      stopPpm: ppmOf(x.stop_micro, x.reference_micro),
      aimPpm: ppmOf(x.aim_micro, x.reference_micro),
      size: masked ? null : money(String(x.size_micro)),
      riskAtStop: masked ? null : money(String(x.risk_micro)),
      outcome:
        x.o_state === null
          ? null
          : {
              state: String(x.o_state),
              entry: masked || x.o_entry === null ? null : money(String(x.o_entry)),
              exitReason: x.o_reason === null ? null : String(x.o_reason),
              netPpm: toNum(x.o_net),
            },
      stock: kit ? kit.aliases.label(code) : code,
      company: masked ? null : x.name === null ? null : String(x.name),
      family: String(x.family),
      tier: String(x.tier),
      label: String(x.label),
      buyUpTo: masked ? null : money(String(x.buy_max_micro)),
      stop: masked ? null : money(String(x.stop_micro)),
      aim: masked ? null : money(String(x.aim_micro)),
      validUntil: masked ? (isoWeek(valid) ?? MISSING) : valid,
      scenario,
      aimReachPpm: toNum(x.aim_reach_ppm),
      timeFrameSessions: toNum(x.time_frame_sessions),
      basedOn: parseList(x.based_on_json).map(t),
      cardHref: x.card_id === null ? null : cardHref(String(x.card_id), masked),
    };
  });
  const stale = dateStaleness(d, todayD(env), STALE_DAYS);
  return {
    ...base,
    state: picks.length === 0 ? "empty" : stale.state === "stale" ? "stale" : "ok",
    d: masked ? (isoWeek(d) ?? MISSING) : d,
    staleText: stale.state === "stale" ? stale.text : null,
    success: await successFor(env, q.profile, d),
    picks,
  };
}

// ---- Why this pick ---------------------------------------------------------------------------------

export type PickDetailModel = {
  masked: boolean;
  profile: string;
  /** The live record beats the luck check (drops "Model not proven yet" from the honesty line). */
  beatsLuck: boolean;
  pick: PickRowView;
  factors: Array<{
    factor: string;
    value: string;
    bucket: number | null;
    n: number | null;
    effect: string;
  }>;
  outcome: {
    state: string;
    entry: MoneyView | null;
    exit: MoneyView | null;
    exitReason: string | null;
    netPpm: number | null;
    netText: string;
  } | null;
};

export const parsePickId = (id: string): { d: string; profile: string; rank: number } | null => {
  const m = ID_RE.exec(id);
  if (!m || !isDateParam(m[1]!)) return null;
  const rank = Number(m[3]);
  return rank >= 1 && rank <= 10 ? { d: m[1]!, profile: m[2]!, rank } : null;
};

/** One pick with its factors and tracked outcome; null when the id is malformed or not stored. */
export async function loadPickDetail(env: LoaderEnv, id: string): Promise<PickDetailModel | null> {
  // A masked viewer can only follow an opaque reference: a readable id gives the same null as an unknown one.
  const real = PK_RE.test(id) ? await resolvePickRef(env, id) : env.mask.masked ? null : id;
  const key = real === null ? null : parsePickId(real);
  if (key === null) return null;
  const market = marketOf(env);
  const model = await loadPicks(env, { profile: key.profile, d: key.d });
  const pick = model.picks.find((p) => p.rank === key.rank);
  if (!pick) return null;
  const r = await env.main.execute({
    sql: `SELECT p.code, p.factors_json, o.state, o.entry_micro, o.exit_micro, o.exit_reason, o.net_ppm
          FROM pick p LEFT JOIN pick_outcome o ON o.market = p.market AND o.d = p.d
            AND o.profile = p.profile AND o.rank = p.rank AND o.kind = 'pick'
          WHERE p.market = ? AND p.d = ? AND p.profile = ? AND p.rank = ?`,
    args: [market, key.d, key.profile, key.rank],
  });
  const x = r.rows[0];
  if (!x) return null;
  const masked = env.mask.masked;
  const kit = masked ? await maskKit(env, key.d, await pickCodes(env, key.d)) : null;
  const t = (s: string): string => (kit ? maskText(s, kit.aliases, kit.lookup) : s);
  let factors: PickDetailModel["factors"] = [];
  try {
    const v: unknown = JSON.parse(String(x.factors_json));
    if (Array.isArray(v)) {
      factors = v.map((f) => {
        const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
        const effect = typeof o.effectPpm === "number" ? o.effectPpm : null;
        return {
          factor: t(String(o.factor ?? "")),
          value: t(String(o.value ?? "")),
          bucket: typeof o.bucket === "number" ? o.bucket : null,
          n: typeof o.n === "number" ? o.n : null,
          effect: o.enough === false ? "not enough history" : formatPpm(effect),
        };
      });
    }
  } catch {
    factors = [];
  }
  const net = toNum(x.net_ppm);
  return {
    masked,
    profile: key.profile,
    beatsLuck: model.success?.beatsLuck ?? false,
    pick,
    factors,
    outcome:
      x.state === null
        ? null
        : {
            state: String(x.state),
            entry: masked || x.entry_micro === null ? null : money(String(x.entry_micro)),
            exit: masked || x.exit_micro === null ? null : money(String(x.exit_micro)),
            exitReason: x.exit_reason === null ? null : String(x.exit_reason),
            netPpm: net,
            netText: net === null ? "not closed yet" : formatPpm(net),
          },
  };
}

// ---- track record ----------------------------------------------------------------------------------

export type TrackRow = {
  id: string;
  d: string;
  stock: string;
  state: string;
  exitReason: string | null;
  netPpm: number | null;
  entry: MoneyView | null;
  exit: MoneyView | null;
  /** The levels and range published with the pick (UXN-043); prices are null for a masked user. */
  published: {
    buyUpTo: MoneyView | null;
    stop: MoneyView | null;
    aim: MoneyView | null;
    badPpm: number | null;
    goodPpm: number | null;
  };
  /** A closed result against the published range. */
  position: "inside" | "below" | "above" | null;
};
export type TrackModel = {
  state: LoaderState;
  masked: boolean;
  profile: string;
  profiles: string[];
  success: (ModelSuccess & { line: string }) | null;
  rows: TrackRow[];
};

export async function loadTrackRecord(env: LoaderEnv, q: { profile: string }): Promise<TrackModel> {
  const market = marketOf(env);
  const r = await env.main.execute({
    sql: `SELECT o.d, o.rank, o.code, o.state, o.exit_reason, o.net_ppm, o.entry_micro, o.exit_micro,
                 p.buy_max_micro, p.stop_micro, p.aim_micro, p.bad_ppm, p.good_ppm
          FROM pick_outcome o JOIN pick p ON p.market = o.market AND p.d = o.d
            AND p.profile = o.profile AND p.rank = o.rank
          WHERE o.market = ? AND o.profile = ? AND o.kind = 'pick'
          ORDER BY o.d DESC, o.rank LIMIT ?`,
    args: [market, q.profile, TRACK_ROWS],
  });
  const profiles = await profileNames(env);
  const masked = env.mask.masked;
  const raw = r.rows.map((x) => ({ d: String(x.d), code: String(x.code), x }));
  // Letters must match the other pages: every pick of those dates joins the active set.
  const kit = masked
    ? await maskKitByDate(env, [...raw, ...(await pickCodesInRange(env, raw))])
    : null;
  const rows: TrackRow[] = raw.map(({ d, code, x }) => ({
    id: publicPickId(`${d}.${q.profile}.${Number(x.rank)}`, masked),
    d: masked ? (isoWeek(d) ?? MISSING) : d,
    stock: kit ? kit.aliasOf(d).label(code) : code,
    state: String(x.state),
    exitReason: x.exit_reason === null ? null : String(x.exit_reason),
    netPpm: toNum(x.net_ppm),
    entry: masked || x.entry_micro === null ? null : money(String(x.entry_micro)),
    exit: masked || x.exit_micro === null ? null : money(String(x.exit_micro)),
    published: {
      buyUpTo: masked ? null : money(String(x.buy_max_micro)),
      stop: masked ? null : money(String(x.stop_micro)),
      aim: masked ? null : money(String(x.aim_micro)),
      badPpm: toNum(x.bad_ppm),
      goodPpm: toNum(x.good_ppm),
    },
    position:
      String(x.state) === "closed"
        ? rangePosition(toNum(x.net_ppm), toNum(x.bad_ppm), toNum(x.good_ppm))
        : null,
  }));
  return {
    state: rows.length === 0 ? "empty" : "ok",
    masked,
    profile: q.profile,
    profiles,
    success: rows.length === 0 ? null : await successFor(env, q.profile, todayD(env)),
    rows,
  };
}
