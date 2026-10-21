// Region & markets view model (UXN-282, MKT-106, D-128 decision 27). Pure helpers plus two readers that
// add the market hours and the per-market sharing check on top of loadSettings. Hours are converted to
// Melbourne time for today's date, so the daylight-saving switch days show the right hours.
import type { Client } from "@libsql/client";
import type { SettingsModel } from "@/lib/ui/loaders/settings";

export type MarketStatus = "active" | "in build" | "testing" | "not started" | "paused";

export type MarketRow = {
  code: string;
  exchange: string;
  currency: string;
  /** "10:00-16:00" in Melbourne time, or null while the profile is not set up. */
  hours: string | null;
  status: MarketStatus;
  /** Plain-words status shown in the table. */
  statusText: string;
  /** Build progress in whole percent when it is stored; null otherwise (never invented). */
  progressPct: number | null;
  selectable: boolean;
};

// MKT-106 lists every market; IN and US have no stored profile before their build starts (MKT-102).
const STATIC_MARKETS: ReadonlyArray<{ code: string; exchange: string; currency: string }> = [
  { code: "IN", exchange: "NSE / BSE", currency: "INR" },
  { code: "US", exchange: "NYSE / Nasdaq", currency: "USD" },
];
const EXCHANGE: Record<string, string> = { AU: "ASX" };
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
      timeZone: "Australia/Melbourne",
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

export type MarketProfiles = Record<string, { tz: string; open: string; close: string }>;

/**
 * The table: every market of MKT-106. The Owner sees all; Editors and Viewers see AU (the home
 * market) and any other market the Owner has shared (a sharing_ack row, D-040).
 */
export function marketRows(
  model: Pick<SettingsModel, "markets">,
  profiles: MarketProfiles,
  sharedCodes: ReadonlySet<string>,
  isOwner: boolean,
  today: string,
): MarketRow[] {
  const rows: MarketRow[] = [];
  const seen = new Set<string>();
  for (const m of model.markets) {
    seen.add(m.code);
    if (!isOwner && m.code !== "AU" && !sharedCodes.has(m.code)) continue;
    const prof = profiles[m.code];
    const s = modeStatus(m.mode);
    const open = prof ? toMelbourne(today, prof.open, prof.tz) : null;
    const close = prof ? toMelbourne(today, prof.close, prof.tz) : null;
    rows.push({
      code: m.code,
      exchange: EXCHANGE[m.code] ?? m.code,
      currency: m.currency,
      hours: open && close ? `${open}–${close}` : null,
      status: s.status,
      statusText: s.text,
      progressPct: null,
      selectable: m.selectable && s.status === "active",
    });
  }
  for (const s of STATIC_MARKETS) {
    if (seen.has(s.code)) continue;
    if (!isOwner && !sharedCodes.has(s.code)) continue;
    rows.push({
      code: s.code,
      exchange: s.exchange,
      currency: s.currency,
      hours: null,
      status: "not started",
      statusText: "Not started",
      progressPct: null,
      selectable: false,
    });
  }
  return rows;
}

export async function readProfiles(main: Pick<Client, "execute">): Promise<MarketProfiles> {
  const r = await main.execute({
    sql: "SELECT code, tz, open_time, close_time FROM market ORDER BY code",
    args: [],
  });
  const out: MarketProfiles = {};
  for (const x of r.rows)
    out[String(x.code)] = {
      tz: String(x.tz),
      open: String(x.open_time),
      close: String(x.close_time),
    };
  return out;
}

export async function readSharedMarkets(auth: Pick<Client, "execute">): Promise<Set<string>> {
  const r = await auth.execute({ sql: "SELECT DISTINCT market FROM sharing_ack", args: [] });
  return new Set(r.rows.map((x) => String(x.market)));
}

/** Reason shown for a market that cannot be chosen (UXN-282: disabled with the reason). */
export function disabledReason(row: MarketRow): string {
  if (row.selectable) return "";
  if (row.status === "not started") return "Not started: no data is collected for this market yet.";
  if (row.status === "paused") return "Paused.";
  if (row.status === "in build" || row.status === "testing")
    return row.progressPct === null ? "In build." : `In build, ${row.progressPct} % done.`;
  return "Not available yet.";
}
