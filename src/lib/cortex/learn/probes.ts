// Candidate measures ("probes") of the learning Cortex (Owner O-81; design C.6 table 5, C.13 step 9,
// self-critique 4). Pure: no database, no clock. A probe is a registry angle a family is trying that
// is NOT in its base: a score angle with a compute and live readers (`canActivate`, D-291), not
// retired. Probes come from recurring mover causes of the daily loop (src/lib/learning/dailyMovers.ts):
// each cause maps to the registry angles that measure it; when none can be tried, the loop can only
// say "a new measure is needed for â€¦" (code is never generated at night). Every probe is charged to
// the trial ledger when it opens, before any result (learn/baseStore.ts `chargeTrial`).
import { angleById, canActivate } from "../angles/registry";
import type { AngleDef, AngleStatus } from "../angles/types";
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { familyWords } from "./learnWords";
import type { CauseNight } from "./baseStore";

/** Sessions of the mover tally ("the last four weeks"). */
export const CAUSE_WINDOW_SESSIONS = 20; // threshold-ok: four weeks of daily movers
/** A cause is recurring when it was behind a big move on at least this many of those nights. */
export const CAUSE_MIN_NIGHTS = 8; // threshold-ok: two nights a week on average
/** The same cause is escalated at most once in this many sessions. */
export const ESCALATE_QUIET_SESSIONS = 60; // threshold-ok: one quarter between repeats
/** A probe a family closed is not opened again for it within this many sessions (each try is charged). */
export const REOPEN_QUIET_SESSIONS = 250; // threshold-ok: one year of trading days

/**
 * Daily-loop cause â†’ the registry angles that measure it, in preference order (C.13 step 9). Causes
 * that no price measure could see (company news) or that are the market itself are not probe sources.
 * An empty list means no angle exists: the loop escalates.
 */
export const CAUSE_ANGLES: Readonly<Record<string, readonly string[]>> = {
  volume_no_news: ["A-D2-07"],
  sector_move: ["A-D1-10", "A-D5-03"],
  stock_specific: [],
};

/** Trading sessions from `from` to `to` (0 for the same night; 0 when `to` is earlier). */
export function sessionsSince(from: string, to: string, calendar: readonly CalendarRow[]): number {
  return to <= from ? 0 : sessionsBetween(from, to, calendar).length - 1;
}

/** Plain words of a cause (Owner text). */
export const CAUSE_WORDS: Readonly<Record<string, string>> = {
  volume_no_news: "heavy trading without news",
  sector_move: "shares moving with their sector",
  stock_specific: "moves that neither news, the sector nor the market explain",
};

/** Short market names of the angles a cause maps to (the registry titles are long). */
const PLAIN_NAMES: Readonly<Record<string, string>> = {
  "A-D2-07": "heavy trading without news",
  "A-D1-10": "strength against its sector",
  "A-D5-03": "sector rotation",
};

/** A measure's plain name: the short name, else its registry title without the parenthesis. */
export function measureName(angleId: string, angles?: readonly AngleDef[]): string {
  const plain = PLAIN_NAMES[angleId];
  if (plain !== undefined) return plain;
  const def = angles?.find((a) => a.id === angleId) ?? angleById(angleId);
  if (def === undefined) return "an unnamed measure";
  const t = def.title.replace(/\s*\(.*\)\s*$/, "").trim();
  return t.length === 0 ? "an unnamed measure" : t.charAt(0).toLowerCase() + t.slice(1);
}

/** Whether `def` may be tried as a probe against a base (not in it, computable live, not retired). */
export function probeEligible(
  def: AngleDef | undefined,
  base: readonly string[],
  status: (id: string) => AngleStatus,
): boolean {
  if (def === undefined || def.kind !== "score" || def.exclusive === true) return false;
  if (base.includes(def.id) || status(def.id) === "retired") return false;
  return canActivate(def).ok;
}

export type ProbeState = {
  readonly family: string;
  readonly angleId: string;
  readonly openedD: string;
  readonly cause: string | null;
  readonly cellId: string;
};

export type ClosedProbe = {
  readonly family: string;
  readonly angleId: string;
  readonly closedD: string;
};

type EventLike = {
  readonly d: string;
  readonly kind: string;
  readonly family?: string | null;
  readonly angleId?: string | null;
  readonly evidence: unknown;
};

const ev = (e: EventLike): Record<string, unknown> =>
  e.evidence !== null && typeof e.evidence === "object"
    ? (e.evidence as Record<string, unknown>)
    : {};

/** Folds the probe events (oldest first) into the open probes and the closes, by (family, angle). */
export function probeStates(events: readonly EventLike[]): {
  open: ProbeState[];
  closed: ClosedProbe[];
} {
  const open = new Map<string, ProbeState>();
  const closed: ClosedProbe[] = [];
  for (const e of events) {
    if (!e.family || !e.angleId) continue;
    const key = `${e.family}|${e.angleId}`;
    if (e.kind === "probe_open") {
      const x = ev(e);
      open.set(key, {
        family: e.family,
        angleId: e.angleId,
        openedD: e.d,
        cause: typeof x.cause === "string" ? x.cause : null,
        cellId: typeof x.cellId === "string" ? x.cellId : "",
      });
    } else if (e.kind === "probe_close") {
      open.delete(key);
      closed.push({ family: e.family, angleId: e.angleId, closedD: e.d });
    }
  }
  const byKey = (a: ProbeState, b: ProbeState): number =>
    a.family < b.family ? -1 : a.family > b.family ? 1 : a.angleId < b.angleId ? -1 : 1;
  return { open: [...open.values()].sort(byKey), closed };
}

export type CauseTally = {
  readonly cause: string;
  /** Nights of the window on which the cause was behind at least one big move. */
  readonly nights: number;
  /** Big moves with that cause over the window. */
  readonly movers: number;
};

/** The recurring causes of the window (only causes CAUSE_ANGLES knows), most frequent first. */
export function recurringCauses(
  nights: readonly CauseNight[],
  minNights: number = CAUSE_MIN_NIGHTS,
): CauseTally[] {
  const tally = new Map<string, { nights: number; movers: number }>();
  for (const n of nights) {
    const seen = new Set<string>();
    for (const m of n.movers) {
      if (!(m.cause in CAUSE_ANGLES)) continue;
      const t = tally.get(m.cause) ?? { nights: 0, movers: 0 };
      t.movers += 1;
      if (!seen.has(m.cause)) {
        t.nights += 1;
        seen.add(m.cause);
      }
      tally.set(m.cause, t);
    }
  }
  return [...tally]
    .filter(([, t]) => t.nights >= minNights)
    .map(([cause, t]) => ({ cause, ...t }))
    .sort((a, b) => b.nights - a.nights || b.movers - a.movers || (a.cause < b.cause ? -1 : 1));
}

export type ProbeAction =
  | {
      readonly kind: "open";
      readonly family: string;
      readonly angleId: string;
      readonly cause: string;
      readonly tally: CauseTally;
    }
  | {
      readonly kind: "covered";
      readonly family: string;
      readonly angleId: string;
      readonly cause: string;
    }
  | { readonly kind: "escalate"; readonly cause: string; readonly tally: CauseTally };

/**
 * The night's probe actions from the recurring causes (pure, deterministic order): per cause and
 * family base, the first mapped angle already in the base covers it; else the first eligible one is
 * opened (unless open, or closed for the family within REOPEN_QUIET_SESSIONS); a cause no family can
 * try and that nothing covers is escalated once per ESCALATE_QUIET_SESSIONS.
 */
export function probeActions(input: {
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly causes: readonly CauseTally[];
  /** family â†’ base angle ids in force. */
  readonly bases: ReadonlyMap<string, readonly string[]>;
  readonly status: (id: string) => AngleStatus;
  readonly open: readonly ProbeState[];
  readonly closed: readonly ClosedProbe[];
  /** Nights the cause was last escalated. */
  readonly lastEscalated: ReadonlyMap<string, string>;
  readonly angles?: readonly AngleDef[];
}): ProbeAction[] {
  const defOf = (id: string): AngleDef | undefined =>
    input.angles?.find((a) => a.id === id) ?? angleById(id);
  const families = [...input.bases.keys()].sort();
  const out: ProbeAction[] = [];
  for (const tally of input.causes) {
    const mapped = CAUSE_ANGLES[tally.cause] ?? [];
    let handled = false;
    for (const family of families) {
      const base = input.bases.get(family)!;
      const inBase = mapped.find((id) => base.includes(id));
      if (inBase !== undefined) {
        out.push({ kind: "covered", family, angleId: inBase, cause: tally.cause });
        handled = true;
        continue;
      }
      const already = mapped.find((id) =>
        input.open.some((p) => p.family === family && p.angleId === id),
      );
      if (already !== undefined) {
        handled = true;
        continue;
      }
      const eligible = mapped.filter((id) => probeEligible(defOf(id), base, input.status));
      // a measure exists (recently tried and closed counts): never "a new measure is needed"
      if (eligible.length > 0) handled = true;
      const pick = eligible.find((id) => {
        const last = input.closed
          .filter((c) => c.family === family && c.angleId === id)
          .map((c) => c.closedD)
          .sort()
          .pop();
        return (
          last === undefined ||
          sessionsSince(last, input.d, input.calendar) >= REOPEN_QUIET_SESSIONS
        );
      });
      if (pick !== undefined) {
        out.push({ kind: "open", family, angleId: pick, cause: tally.cause, tally });
        handled = true;
      }
    }
    if (handled) continue;
    const last = input.lastEscalated.get(tally.cause);
    if (
      last === undefined ||
      sessionsSince(last, input.d, input.calendar) >= ESCALATE_QUIET_SESSIONS
    ) {
      out.push({ kind: "escalate", cause: tally.cause, tally });
    }
  }
  return out;
}

const causeWords = (cause: string): string => CAUSE_WORDS[cause] ?? "a kind of move";

export function probeOpenWords(family: string, angleId: string, t: CauseTally): string {
  return `Started trying a candidate measure for ${familyWords(family)}: ${measureName(angleId)}, because ${causeWords(t.cause)} was behind ${t.movers} of the biggest moves over the last four weeks. It joins the base only if it proves itself over at least six months.`;
}

export function escalateWords(t: CauseTally): string {
  return `A new measure is needed for ${causeWords(t.cause)}: they were behind ${t.movers} of the biggest moves over the last four weeks, and no measure the Cortex has can capture them.`;
}

export type ProbeCloseReason = "futile" | "expired" | "promoted" | "base_has_it";

export function probeCloseWords(family: string, angleId: string, reason: ProbeCloseReason): string {
  const name = measureName(angleId);
  if (reason === "promoted")
    return `Stopped trying ${name} for ${familyWords(family)}: it is now part of the base.`;
  if (reason === "base_has_it")
    return `Stopped trying ${name} for ${familyWords(family)}: the base already has it.`;
  if (reason === "expired")
    return `Stopped trying ${name} for ${familyWords(family)}: a year of results did not give evidence strong enough to add it to the base.`;
  return `Stopped trying ${name} for ${familyWords(family)}: it has not pointed the right way, so it will not join the base.`;
}
