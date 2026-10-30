// D4 Fundamentals and quality: registry entries (M15 C1c; angles_D4.md; CTX-011, DAT-170). Every
// angle that reads Yahoo fundamentals carries `needsData` (no point-in-time snapshot history before
// ARN-082 coverage) and stays `candidate`. Three are computable from price and vendor actions today
// and share one implementation with the offline run (D-278): A-D4-05 (trailing cash yield from the
// known dividend actions), A-D4-07 (the momentum-only variant of the value-momentum composite) and
// A-D4-08 (252-session realised volatility). A-D4-04 is defined from the guidance events the feed
// records, so it keeps a compute behind the announcement-archive `needsData` (CTX-051).
import { logReturns, microToFloat, stdevFloat } from "@/lib/agents/indicators";
import { ANNOUNCEMENT_ARCHIVE, eventsWithin } from "./d3";
import type { AngleDef } from "./types";

export const FUNDAMENTALS_HISTORY = "fundamentals snapshot history (DAT-170)";

const DAY_MS = 86_400_000; // threshold-ok: milliseconds per day

/** `d` minus `days` calendar days as YYYY-MM-DD (UTC arithmetic on a date-only value). */
export function daysBefore(d: string, days: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Cash dividend per share from a DAT-220 payload (`dps` as text or number); null when absent. */
export function dpsOf(payload: Readonly<Record<string, unknown>>): number | null {
  const raw = payload.dps;
  const v = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export const D4_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D4-01",
    version: 1,
    domain: 4,
    title: "Earnings yield versus sector median (refines F2)",
    definition:
      "clip((sector median P/E - P/E) / median, -1, 1) with P/E = close / trailing EPS for EPS > 0, the median over U1 codes of the GICS industry group with data (>= 8 codes, else unknown); negative EPS keeps the F2 veto.",
    kind: "score",
    cluster: "quality",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 0,
    inputs: ["bar_au", "sector_map"],
    grid: { min_sector_codes: [8] },
    needsData: FUNDAMENTALS_HISTORY,
    historyFields: ["no replay before ARN-082 coverage; forward snapshots only (fetched_at)"],
    existing: ["F2 ch. 07 §7.4", "DAT-170", "CTX-025"],
  },
  {
    id: "A-D4-02",
    version: 1,
    domain: 4,
    title: "Quality: return on equity and margins",
    definition:
      "tanh of the mean sector z-score of ROE (NPAT / average equity) and EBIT margin, winsorised at 1 % / 99 %; banks and insurers use sector-specific measures.",
    kind: "score",
    cluster: "quality",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 0,
    inputs: ["bar_au", "sector_map"],
    grid: {},
    needsData: FUNDAMENTALS_HISTORY,
    historyFields: ["half-year reporting lag; one-off items in NPAT"],
    existing: ["K-029", "DAT-170"],
  },
  {
    id: "A-D4-03",
    version: 1,
    domain: 4,
    title: "Balance-sheet risk: net debt to EBIT and interest cover (refines the F2 gate)",
    definition:
      "Veto when EBIT <= 0 with net debt > 0, net debt / EBIT > nd_ebit_max or interest cover < cover_min; a risk level shown as a gate input, never a score feature; F2's net debt / EBITDA < 2 gate stays.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["bar_au"],
    grid: { nd_ebit_max: [4, 3, 5], cover_min: [2, 1.5, 3] },
    needsData: FUNDAMENTALS_HISTORY,
    historyFields: ["AASB 16 leases inflate debt; EBIT <= 0 is a veto, not a value"],
    existing: ["F2 ch. 07 §7.4", "K-029", "DAT-170"],
  },
  {
    id: "A-D4-04",
    version: 1,
    domain: 4,
    title: "Earnings-revision proxy from guidance events",
    definition:
      "clip(rev, -1, 1) with rev = (sum of weights of guidance-up events - sum for guidance-down) / max(1, total weight) over the trailing window sessions, each event weighted exp(-age / decay); undefined with no guidance event (0 would mean 'no events'); U2/U3 entries count only guidance with parsed statements (CTX-043).",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 120,
    inputs: ["announcement"],
    grid: { window: [120], decay: [60] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "guidance events are sparse on the ASX: the passport reports n of codes with any event",
      "true analyst revision breadth needs a source (K-034)",
    ],
    existing: ["AGT-020", "K-034", "CTX-043"],
    compute: (view, code, t, grid) => {
      const rows = eventsWithin(view, code, t, grid.window!).filter(
        (e) => e.category === "guidance_up" || e.category === "guidance_down",
      );
      if (rows.length === 0) return undefined;
      let up = 0;
      let down = 0;
      for (const e of rows) {
        const w = Math.exp(-e.age / grid.decay!);
        if (e.category === "guidance_up") up += w;
        else down += w;
      }
      const rev = (up - down) / Math.max(1, up + down);
      return rev === 0 ? 0 : rev > 1 ? 1 : rev < -1 ? -1 : rev;
    },
  },
  {
    id: "A-D4-05",
    version: 1,
    domain: 4,
    title: "Dividend yield with franking (AU)",
    definition:
      "Trailing cash yield = sum of cash dividends per share (DAT-220 actions known at the cut-off) with ex-date inside the last 365 days up to tonight, divided by tonight's close; rank within sector happens at standardisation; franking is display only (unknown without the announcement text).",
    kind: "score",
    cluster: "quality",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 252,
    inputs: ["corp_action", "bar_au"],
    grid: { trailing_days: [365] },
    historyFields: [
      "franking % is not in any free feed (needs the announcement text, DAT-122): shown as unknown, never 0",
      "special dividends are not distinguished in the vendor row: included in the trailing sum",
      "dividends before a split in the window are per pre-split share: the yield is on the raw basis of each ex-date",
    ],
    existing: ["DAT-220", "K-056", "P-04-1"],
    compute: (view, code, t, grid) => {
      if (view.barCount(code, t) < 252) return undefined;
      const last = view.bars(code, t, 1)[0];
      if (last === undefined || last.close <= 0n) return undefined;
      const from = daysBefore(last.d, grid.trailing_days!);
      let dps = 0;
      for (const a of view.corpActions(code, t)) {
        if (a.type !== "cash_dividend" || a.exDate <= from || a.exDate > last.d) continue;
        const v = dpsOf(a.payload);
        if (v !== null) dps += v;
      }
      return dps / microToFloat(last.close);
    },
  },
  {
    id: "A-D4-06",
    version: 1,
    domain: 4,
    title: "Growth at a reasonable price (PEG proxy)",
    definition:
      "clip((1.5 - PEG) / 1.0, -1, 1) with PEG = P/E / (3-year EPS CAGR x 100) for positive growth only; K-031's 1.0 / 1.5 are reference values, not entry or exit rules.",
    kind: "score",
    cluster: "quality",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 0,
    inputs: ["bar_au"],
    grid: {},
    needsData: "EPS history for >= 3 fiscal years per code (annual PDF extraction, P-08-10)",
    historyFields: ["no test until the EPS history exists"],
    existing: ["K-031", "P-08-10"],
  },
  {
    id: "A-D4-07",
    version: 1,
    domain: 4,
    title: "Value-momentum combination (momentum-only variant until EY exists)",
    definition:
      "Composite 0.5 x pct_rank(lookback-session return, no skip month on U1) + 0.5 x pct_rank(EY); until the value leg exists the value is the lookback-session adjusted-close return alone, labelled 'momentum-only variant' (adding the leg is a refit, CTX-060); the percentile is the nightly standardisation.",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 126,
    warmupSessions: 127,
    inputs: ["bar_au"],
    grid: { lookback: [126] },
    historyFields: [
      "value leg needs fundamentals history (DAT-170): the measured history is the momentum-only variant",
      "overlaps the D1 momentum angles: distinctness is tested at calibration (CTX-033)",
    ],
    existing: ["K-028", "K-018", "P-10-7"],
    compute: (view, code, t, grid) => {
      const n = grid.lookback! + 1;
      if (view.barCount(code, t) < n) return undefined;
      const closes = view.adj(code, t, n).adjClose;
      const first = closes[0]!;
      const lastClose = closes[closes.length - 1]!;
      if (first <= 0n || lastClose <= 0n) return undefined;
      const r = microToFloat(lastClose) / microToFloat(first) - 1;
      return r === 0 ? 0 : r;
    },
  },
  {
    id: "A-D4-08",
    version: 1,
    domain: 4,
    title: "Low-volatility defensive tilt",
    definition:
      "Minus the sample standard deviation of the last window daily log returns of the adjusted close (so a higher value = lower volatility, orientation +1); the percentile within U1 is the nightly standardisation; a score feature in the low-volatility cluster, no regime size effect (CTX-017).",
    kind: "score",
    cluster: "low_volatility",
    orientation: 1,
    horizonSessions: 126,
    warmupSessions: 253,
    inputs: ["bar_au"],
    grid: { window: [252] },
    historyFields: [
      "a different window from AGT-101's 20-session volatility percentile (no double count)",
    ],
    existing: ["K-029", "R-07-2"],
    compute: (view, code, t, grid) => {
      const w = grid.window!;
      if (view.barCount(code, t) < w + 1) return undefined;
      const closes = view.adj(code, t, w + 1).adjClose;
      if (closes.some((c) => c <= 0n)) return undefined;
      const sd = stdevFloat(logReturns(closes.map(microToFloat)), w, 1);
      return sd === null ? undefined : sd === 0 ? 0 : -sd;
    },
  },
  {
    id: "A-D4-09",
    version: 1,
    domain: 4,
    title: "Graham and Greenblatt screens as challengers",
    definition:
      "Greenblatt rank(EBIT / EV) + rank(EBIT / (net fixed assets + working capital)) top-N membership, and the Graham net-current-asset flag (price < 2/3 NCAV per share); challenger only.",
    kind: "score",
    cluster: "quality",
    orientation: 1,
    horizonSessions: 250,
    warmupSessions: 0,
    inputs: ["bar_au"],
    grid: { top_n: [30, 20] },
    needsData: FUNDAMENTALS_HISTORY,
    historyFields: ["the NCAV set is near empty among ASX large caps"],
    existing: ["K-028", "K-030"],
  },
  {
    id: "A-D4-10",
    version: 1,
    domain: 4,
    title: "Cash-flow quality and accruals",
    definition:
      "Minus the sector z-score of accruals = (NPAT - OCF) / average total assets, winsorised 1 % / 99 %; F2 candidates vetoed when the accruals z-score exceeds accruals_z_veto.",
    kind: "score",
    cluster: "quality",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 0,
    inputs: ["bar_au", "sector_map"],
    grid: { accruals_z_veto: [2, 1.5, 2.5] },
    needsData: "fundamentals snapshot history with OCF and total assets (DAT-170)",
    historyFields: [
      "banks have no meaningful OCF; capex-heavy growers show high accruals by design",
    ],
    existing: ["K-029", "N4"],
  },
];
