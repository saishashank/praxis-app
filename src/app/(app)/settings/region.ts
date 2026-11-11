// Region & markets view model (UXN-282, UXN-312, MKT-106, MKT-114, D-128 decision 27, D-997, D-998). Pure
// helpers plus two readers that add the market hours and the per-market sharing check on top of loadSettings.
// Hours are converted to Melbourne time for today's date, so the daylight-saving switch days show the right
// hours. Every row comes from the `market` table and its profile (the static IN/US rows and the exchange map
// are gone: every built market has a row). The Owner sees every row; Editors and Viewers see enabled markets
// only, never a built-off row (D-997).
import type { Client } from "@libsql/client";
import { loadProfile } from "@/lib/market/profile";
import { HOME_MARKET, OWNER_TZ } from "@/lib/market/profileCore.mjs";
import type { SettingsModel } from "@/lib/ui/loaders/settings";

export type MarketStatus = "active" | "built" | "in build" | "testing" | "not started" | "paused";

export type MarketRow = {
  code: string;
  exchange: string;
  currency: string;
  /** "10:00-16:00" in Melbourne time, or null while the profile is not set up. */
  hours: string | null;
  status: MarketStatus;
  /** Plain-words status shown in the table (D-998). */
  statusText: string;
  /** Build progress in whole percent when it is stored; null otherwise (never invented). */
  progressPct: number | null;
  selectable: boolean;
  /** True when the market is switched on for use (the `market.enabled` flag). */
  enabled: boolean;
  /** Built rows only: "AT-M evidence: not recorded" or the date it was recorded (MKT-114). */
  evidence: string | null;
  /** Built rows only: the gates still open, in fixed words (MKT-111, M20 carries the checklist). */
  gateItems: string[];
  /** "Profile: n of m fields verified" (DAT-242, D-998); null when no profile is stored. */
  profileLine: string | null;
};

export type WorkStatus = "not_started" | "in_build" | "testing" | "built" | "active" | "paused";

const MS_PER_MINUTE = 60_000; // threshold-ok: unit conversion

const offsetMinutes = (tz: string, at: Date): number => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - at.getTime()) / MS_PER_MINUTE);
};

/** HH:MM wall-clock time of a market on `day` (YYYY-MM-DD), shown in Melbourne. */
export function toMelbourne(day: string, hm: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m || !t) return null;
  try {
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    let utc = wall - offsetMinutes(tz, new Date(wall)) * MS_PER_MINUTE;
    utc = wall - offsetMinutes(tz, new Date(utc)) * MS_PER_MINUTE; // settle across a DST edge
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: OWNER_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(utc));
  } catch {
    return null;
  }
}

function modeStatus(mode: string): { status: MarketStatus; text: string } {
  // market.mode mirrors the market_mode key (D-057): 'full' trades, 'data_only' collects data only.
  if (mode === "full") return { status: "active", text: "Active" };
  if (mode === "data_only") return { status: "active", text: "Active (collecting data only)" };
  return { status: "paused", text: "Paused" };
}

/** What the table needs from a stored profile (never the profile's values themselves). */
export type MarketProfileView = {
  tz: string;
  open: string;
  close: string;
  exchange: string | null;
  workStatus: WorkStatus;
  /** Date the AT-M evidence was recorded (YYYY-MM-DD), or null. */
  evidenceRecordedAt: string | null;
  verified: number;
  total: number;
};
export type MarketProfiles = Record<string, MarketProfileView>;

/**
 * The status text of one market, from its stored work status and its mode (D-998, MKT-114):
 * active + full "Active"; active + data_only "Active (collecting data only)"; active + off "Paused";
 * built "Built — off in production"; the other work statuses in words. Without a profile the mode decides.
 */
export function statusText(
  profile: Pick<MarketProfileView, "workStatus"> | undefined,
  mode: string,
): { status: MarketStatus; text: string } {
  if (profile === undefined) return modeStatus(mode);
  switch (profile.workStatus) {
    case "active":
      return modeStatus(mode);
    case "built":
      return { status: "built", text: "Built — off in production" };
    case "in_build":
      return { status: "in build", text: "In build" };
    case "testing":
      return { status: "testing", text: "Testing" };
    case "paused":
      return { status: "paused", text: "Paused" };
    default:
      return { status: "not started", text: "Not started" };
  }
}

/** The gates still open on a built market, in fixed words (the checklist with evidence links is M20, D-1001). */
export const BUILT_GATE_ITEMS: readonly string[] = [
  "AU 60 trading days (MKT-105)",
  "Owner approval",
];

/**
 * The table. The Owner sees every row in `model.markets` (every profile row); Editors and Viewers see the
 * enabled markets only, and of those the home market and any the Owner has shared (a sharing_ack row, D-040).
 */
export function marketRows(
  model: Pick<SettingsModel, "markets">,
  profiles: MarketProfiles,
  sharedCodes: ReadonlySet<string>,
  isOwner: boolean,
  today: string,
): MarketRow[] {
  const rows: MarketRow[] = [];
  for (const m of model.markets) {
    if (!isOwner && !m.enabled) continue;
    if (!isOwner && m.code !== HOME_MARKET && !sharedCodes.has(m.code)) continue;
    const prof = profiles[m.code];
    const s = statusText(prof, m.mode);
    const open = prof ? toMelbourne(today, prof.open, prof.tz) : null;
    const close = prof ? toMelbourne(today, prof.close, prof.tz) : null;
    const built = s.status === "built";
    rows.push({
      code: m.code,
      exchange: prof?.exchange ?? m.code,
      currency: m.currency,
      hours: open && close ? `${open}–${close}` : null,
      status: s.status,
      statusText: s.text,
      progressPct: null,
      selectable: m.selectable && s.status === "active",
      enabled: m.enabled,
      evidence: built
        ? prof?.evidenceRecordedAt
          ? `AT-M evidence: recorded ${prof.evidenceRecordedAt}`
          : "AT-M evidence: not recorded"
        : null,
      gateItems: built ? [...BUILT_GATE_ITEMS] : [],
      profileLine: prof ? `Profile: ${prof.verified} of ${prof.total} fields verified` : null,
    });
  }
  return rows;
}

/** One profile per `market` row, through the loader (cached); a market whose profile cannot be read is left out. */
export async function readProfiles(main: Pick<Client, "execute">): Promise<MarketProfiles> {
  const r = await main.execute({ sql: "SELECT code FROM market ORDER BY code", args: [] });
  const out: MarketProfiles = {};
  for (const x of r.rows) {
    const code = String(x.code);
    try {
      const p = await loadProfile(main, code);
      out[code] = {
        tz: p.tz ?? "",
        open: p.sessionOpen ?? "",
        close: p.sessionClose ?? "",
        exchange: p.exchange,
        workStatus: p.workStatus as WorkStatus,
        evidenceRecordedAt:
          p.evidenceRecordedAt === null ? null : p.evidenceRecordedAt.slice(0, 10),
        verified: p.completeness.verified,
        total: p.completeness.total,
      };
    } catch {
      /* a market with no readable profile shows its mode status and no hours */
    }
  }
  return out;
}

export async function readSharedMarkets(auth: Pick<Client, "execute">): Promise<Set<string>> {
  const r = await auth.execute({ sql: "SELECT DISTINCT market FROM sharing_ack", args: [] });
  return new Set(r.rows.map((x) => String(x.market)));
}

/** Reason shown for a market that cannot be chosen (UXN-282: disabled with the reason). */
export function disabledReason(row: MarketRow): string {
  if (row.selectable) return "";
  if (row.status === "built") return "Built — off in production.";
  if (row.status === "not started") return "Not started: no data is collected for this market yet.";
  if (row.status === "paused") return "Paused.";
  if (row.status === "in build" || row.status === "testing")
    return row.progressPct === null ? "In build." : `In build, ${row.progressPct} % done.`;
  return "Not available yet.";
}
