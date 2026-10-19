// Lesson windows (M6 T4; ARN-063, KB-020; docs/M6_design.md 2.1 and 2.3; D-117 proposed).
//
// Per lineage and split version: Dev = the development entry sessions, P = the purge. Drop P sessions to
// place the purge between the two parts: L1 window = the first floor(2/3 x (|Dev| - P)) entry sessions,
// purge = the next P sessions, L2 window = the rest of Dev. Frozen in `lesson_window` at split creation
// or roll. A deferred split (development too short) has no window, so only L0 lessons exist.
//
// Look-ahead (TST-109): a row counts in a window only when its entry session is one of the window's
// sessions AND its outcome is fully observed on or before the as-of date. Validation and holdout rows
// are not representable here: every row carries `part: "development"` and anything else is refused.
// Pure functions except `freezeLessonWindow`, which is idempotent (same window writes nothing, a
// different window at the same split version RAISES).
import type { Client } from "@libsql/client";

type Exec = Pick<Client, "execute">;

export class LessonError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LessonError";
    this.code = code;
  }
}

/** The L1 sessions, the purge sessions and the L2 sessions (each ascending, disjoint, contiguous). */
export type LessonWindows = {
  readonly l1: readonly string[];
  readonly purge: readonly string[];
  readonly l2: readonly string[];
};

const DATE_RE = /^\d\d\d\d-\d\d-\d\d$/;

function checkSessions(sessions: readonly string[]): void {
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i]!;
    if (!DATE_RE.test(s)) throw new LessonError("bad_session", `not a date: ${s}`);
    if (i > 0 && !(sessions[i - 1]! < s)) {
      throw new LessonError("bad_session", "development sessions must be ascending and unique");
    }
  }
}

/**
 * Split the development entry sessions into the L1 window, the purge and the L2 window. Returns null
 * for a deferred split or when either window would be empty (no lesson above L0 can exist).
 */
export function splitLessonWindows(
  devSessions: readonly string[],
  purge: number,
  deferred = false,
): LessonWindows | null {
  if (!Number.isInteger(purge) || purge < 0) throw new RangeError("purge must be >= 0");
  checkSessions(devSessions);
  if (deferred) return null;
  const usable = devSessions.length - purge;
  if (usable < 1) return null;
  const l1Count = Math.floor((2 * usable) / 3); // threshold-ok: ARN-063 fixed two-thirds split
  const l2Start = l1Count + purge;
  if (l1Count < 1 || l2Start >= devSessions.length) return null;
  return {
    l1: devSessions.slice(0, l1Count),
    purge: devSessions.slice(l1Count, l2Start),
    l2: devSessions.slice(l2Start),
  };
}

/** The bounds of a window as dates. */
export function windowBounds(sessions: readonly string[]): { start: string; end: string } {
  if (sessions.length === 0) throw new LessonError("empty_window", "empty window");
  return { start: sessions[0]!, end: sessions[sessions.length - 1]! };
}

/**
 * Cross-family (market pool) windows (ARN-063): per boundary the EARLIEST date of the lineages
 * involved. The session lists are the sessions of the earliest-ending lineage restricted to the
 * boundary dates, so every part is a sub-range of every lineage's own part.
 */
export function crossFamilyWindows(all: readonly LessonWindows[]): LessonWindows | null {
  if (all.length === 0) return null;
  const min = (xs: readonly string[]): string => xs.reduce((a, b) => (b < a ? b : a));
  const l1Start = min(all.map((w) => windowBounds(w.l1).start));
  const l1End = min(all.map((w) => windowBounds(w.l1).end));
  const l2Start = min(all.map((w) => windowBounds(w.l2).start));
  const l2End = min(all.map((w) => windowBounds(w.l2).end));
  // Union of the sessions of every lineage, cut at the boundaries (a sorted, unique list).
  const universe = [...new Set(all.flatMap((w) => [...w.l1, ...w.purge, ...w.l2]))].sort();
  const l1 = universe.filter((s) => s >= l1Start && s <= l1End);
  const l2 = universe.filter((s) => s >= l2Start && s <= l2End);
  const purge = universe.filter((s) => s > l1End && s < l2Start);
  if (l1.length === 0 || l2.length === 0) return null;
  return { l1, purge, l2 };
}

// ---- rows ------------------------------------------------------------------------------------------------

/** What the window logic needs of a row: development only, with its entry and observed dates. */
export type WindowRow = {
  readonly part: "development";
  readonly entryD: string;
  readonly observedD: string;
};

/** Refuse any row that is not development data (module-boundary guard, KB-040, ARN-063). */
export function assertDevelopment(rows: readonly { readonly part: string }[]): void {
  for (const r of rows) {
    if (r.part !== "development") {
      throw new LessonError("not_development", "lessons use development rows only (ARN-063)");
    }
  }
}

/** A window's rows with their session index (0..S-1); look-ahead safe, in input order. */
export type WindowedRows<T> = {
  readonly rows: readonly T[];
  /** Session index of each row in `rows`. */
  readonly sessions: readonly number[];
  readonly sessionCount: number;
};

/**
 * Rows whose entry session is in `windowSessions` and whose outcome is observed on or before `asOfD`.
 * Rows entered or observed later are invisible: changing them cannot change any result.
 */
export function rowsInWindow<T extends WindowRow>(
  rows: readonly T[],
  windowSessions: readonly string[],
  asOfD: string,
): WindowedRows<T> {
  assertDevelopment(rows);
  const index = new Map<string, number>();
  windowSessions.forEach((s, i) => index.set(s, i));
  const outRows: T[] = [];
  const outSessions: number[] = [];
  for (const r of rows) {
    const i = index.get(r.entryD);
    if (i === undefined) continue;
    if (r.observedD > asOfD) continue;
    outRows.push(r);
    outSessions.push(i);
  }
  return { rows: outRows, sessions: outSessions, sessionCount: windowSessions.length };
}

// ---- persistence -----------------------------------------------------------------------------------------

export type LessonWindowRow = {
  readonly lineage_id: string;
  readonly split_version: number;
  readonly l1_start_d: string;
  readonly l1_end_d: string;
  readonly purge: number;
  readonly l2_start_d: string;
  readonly l2_end_d: string;
  readonly block: number;
  readonly frozen_run: string;
};

export function lessonWindowRow(
  lineageId: string,
  splitVersion: number,
  w: LessonWindows,
  block: number,
  frozenRun: string,
): LessonWindowRow {
  const a = windowBounds(w.l1);
  const b = windowBounds(w.l2);
  return {
    lineage_id: lineageId,
    split_version: splitVersion,
    l1_start_d: a.start,
    l1_end_d: a.end,
    purge: w.purge.length,
    l2_start_d: b.start,
    l2_end_d: b.end,
    block,
    frozen_run: frozenRun,
  };
}

const WINDOW_COLS = ["l1_start_d", "l1_end_d", "purge", "l2_start_d", "l2_end_d", "block"] as const;

/** Insert the frozen window once. Same content again writes nothing; different content RAISES. */
export async function freezeLessonWindow(
  tx: Exec,
  row: LessonWindowRow,
): Promise<"inserted" | "unchanged"> {
  const cur = await tx.execute({
    sql: "SELECT * FROM lesson_window WHERE lineage_id = ? AND split_version = ?",
    args: [row.lineage_id, row.split_version],
  });
  if (cur.rows.length > 0) {
    const r = cur.rows[0]!;
    for (const c of WINDOW_COLS) {
      if (String(r[c]) !== String(row[c])) {
        throw new LessonError(
          "window_conflict",
          `lesson_window ${row.lineage_id} v${row.split_version}: ${c} differs`,
        );
      }
    }
    return "unchanged";
  }
  await tx.execute({
    sql: `INSERT INTO lesson_window (lineage_id, split_version, l1_start_d, l1_end_d, purge, l2_start_d,
            l2_end_d, block, frozen_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.lineage_id,
      row.split_version,
      row.l1_start_d,
      row.l1_end_d,
      row.purge,
      row.l2_start_d,
      row.l2_end_d,
      row.block,
      row.frozen_run,
    ],
  });
  return "inserted";
}
