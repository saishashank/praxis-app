// Halt-resolution watch (CR-MOV-A1; D-741…D-744). A state, not an angle: for every halted or suspended
// code it records WHY (a reason class from a fixed phrase list, no model call), which way the resume
// has tended to go (expected sign), and when trading came back. Pure over plain facts: the producer
// (cortex/store/movers.ts) reads the live announcements and the view's halted flags and writes the
// `halt_watch` rows this module describes. Nothing here places or changes an order.
//
//   none ──halt / suspension notice effective <= D, code halted (or notice effective on D)──> open
//   open ──first traded session after the notice──> resumed (resume_d)       [row appended]
//
// Expected sign by class (the study's reading of the halt return, uncalibrated; shadow only):
//   capital_raise -1 (discounted raisings)   takeover +1   material_announcement 0   regulatory 0   unknown 0
// The halt title alone is often just "Trading Halt": the producer therefore passes the titles of the
// code's other announcements in the notice window as extra texts, and an unclassified halt stays `unknown`.
import type { MoversParams } from "../moversParams";

export type HaltReasonClass =
  "capital_raise" | "takeover" | "material_announcement" | "regulatory" | "unknown";
export type WatchNoticeKind = "halt" | "suspension" | "reinstatement";
export type ExpectedSign = -1 | 0 | 1;

/** Fixed phrase list, tried in this order (a raising that funds a deal is still a raising). */
const REASON_PHRASES: readonly {
  readonly cls: Exclude<HaltReasonClass, "unknown">;
  readonly sign: ExpectedSign;
  readonly re: RegExp;
}[] = [
  {
    cls: "capital_raise",
    sign: -1,
    re: /\b(capital raising|capital raise|placement|entitlement|rights issue|equity raising|share purchase plan|institutional offer|proposed issue of securities)\b/i,
  },
  {
    cls: "takeover",
    sign: 1,
    re: /\b(proposed transaction|acquisition|scheme of arrangement|scheme|takeover|change of control|merger|business combination)\b/i,
  },
  {
    cls: "regulatory",
    sign: 0,
    re: /\b(asx query|aware letter|price query|listing rule|asic|investigation|regulatory)\b/i,
  },
  {
    cls: "material_announcement",
    sign: 0,
    re: /\b(results|guidance|trading update|update|contract|drilling|resource estimate|announcement)\b/i,
  },
];

const REINSTATE_RE = /\b(reinstatement|reinstated|resumption of trading|resume trading)\b/i;
const SUSPEND_RE = /\bsuspen(sion|ded)\b/i;
const HALT_RE = /\b(trading halt|pause in trading)\b/i;

/** The watch's notice kind from an announcement type and title; null for any other announcement. */
export function watchNoticeKind(type: string | null, title: string): WatchNoticeKind | null {
  const text = `${type ?? ""} ${title}`;
  if (REINSTATE_RE.test(text)) return "reinstatement";
  if (SUSPEND_RE.test(text)) return "suspension";
  if (HALT_RE.test(text)) return "halt";
  return null;
}

/** The reason class and expected sign from the notice texts (halt title first, then the neighbours). */
export function classifyHaltReason(texts: readonly string[]): {
  readonly reasonClass: HaltReasonClass;
  readonly expectedSign: ExpectedSign;
} {
  for (const p of REASON_PHRASES) {
    if (texts.some((t) => p.re.test(t))) return { reasonClass: p.cls, expectedSign: p.sign };
  }
  return { reasonClass: "unknown", expectedSign: 0 };
}

/** One halt or suspension notice as the watch sees it. */
export type WatchNotice = {
  readonly kind: WatchNoticeKind;
  /** `${source}|${ann_id}` */
  readonly ref: string;
  /** The first session the notice bites: its publication session, or the next one when published after the close. */
  readonly effectiveD: string;
  /** The notice title first, then the titles of the same code's announcements around it. */
  readonly texts: readonly string[];
};

export type HaltWatchState =
  | { readonly state: "none" }
  | {
      readonly state: "open";
      readonly sinceD: string;
      readonly reasonClass: HaltReasonClass;
      readonly expectedSign: ExpectedSign;
      readonly noticeRef: string | null;
    };

export const WATCH_NONE: HaltWatchState = { state: "none" };

export type HaltWatchFacts = {
  readonly d: string;
  /** The view's halted flag tonight; null = unknown (treated as not halted). */
  readonly haltedNow: boolean | null;
  /** The code has a bar dated `d` with volume > 0. */
  readonly tradedNow: boolean;
  /** Halt / suspension notices known by the cut-off with effectiveD <= d. */
  readonly notices: readonly WatchNotice[];
  /** since_d of the latest watch of this code that has already resumed (it is never reopened). */
  readonly lastResolvedSinceD: string | null;
};

/** The row to append (status 'open' or 'resumed'); the store adds market, seq and known_at. */
export type HaltWatchRowOut = {
  readonly sinceD: string;
  readonly status: "open" | "resumed";
  readonly reasonClass: HaltReasonClass;
  readonly expectedSign: ExpectedSign;
  readonly noticeRef: string | null;
  readonly resumeD: string | null;
};

export type HaltWatchStep = {
  readonly next: HaltWatchState;
  readonly row: HaltWatchRowOut | null;
};

/** One night of the machine; pure. */
export function stepHaltWatch(prev: HaltWatchState, f: HaltWatchFacts): HaltWatchStep {
  if (prev.state === "open") {
    if (f.tradedNow && f.haltedNow !== true && f.d > prev.sinceD) {
      return {
        next: WATCH_NONE,
        row: {
          sinceD: prev.sinceD,
          status: "resumed",
          reasonClass: prev.reasonClass,
          expectedSign: prev.expectedSign,
          noticeRef: prev.noticeRef,
          resumeD: f.d,
        },
      };
    }
    return { next: prev, row: null };
  }
  const fresh = f.notices
    .filter((n) => n.kind !== "reinstatement")
    .filter((n) => f.lastResolvedSinceD === null || n.effectiveD > f.lastResolvedSinceD)
    .filter((n) => n.effectiveD <= f.d)
    .filter((n) => f.haltedNow === true || n.effectiveD === f.d)
    .sort((a, b) => (a.effectiveD < b.effectiveD ? 1 : a.effectiveD > b.effectiveD ? -1 : 0));
  const n = fresh[0];
  if (n === undefined) return { next: prev, row: null };
  const { reasonClass, expectedSign } = classifyHaltReason(n.texts);
  const next: HaltWatchState = {
    state: "open",
    sinceD: n.effectiveD,
    reasonClass,
    expectedSign,
    noticeRef: n.ref,
  };
  return {
    next,
    row: {
      sinceD: n.effectiveD,
      status: "open",
      reasonClass,
      expectedSign,
      noticeRef: n.ref,
      resumeD: null,
    },
  };
}

/** The latest row of one watch as the gates and the arming read it. */
export type HaltWatchView = {
  readonly sinceD: string;
  readonly status: "open" | "resumed";
  readonly reasonClass: HaltReasonClass;
  readonly expectedSign: ExpectedSign;
  readonly resumeD: string | null;
};

/** Families a negative resume keeps out (dip-buy and short-cover entries). */
export const HALT_RESUME_BLOCKED_FAMILIES: ReadonlySet<string> = new Set(["F4", "F6"]);

/** Sessions from a to b (b - a) in the session list; Infinity when either is absent. */
function sessionGap(sessions: readonly string[], a: string, b: string): number {
  const ia = sessions.indexOf(a);
  const ib = sessions.indexOf(b);
  return ia < 0 || ib < 0 ? Infinity : ib - ia;
}

/**
 * The resume-day rule (A1, gate sub-check 8f): no F4 / F6 entry while a watch with an expected sign of
 * zero or below is open (and younger than the expiry), nor in the `haltResumeBlockSessions` sessions
 * that begin on the resume day. Null when nothing applies.
 */
export function haltResumeVeto(x: {
  readonly watch: HaltWatchView | null;
  readonly family: string;
  readonly d: string;
  readonly sessions: readonly string[];
  readonly params: Pick<MoversParams, "haltResumeBlockSessions" | "haltWatchExpirySessions">;
}): string | null {
  const w = x.watch;
  if (w === null || !HALT_RESUME_BLOCKED_FAMILIES.has(x.family) || w.expectedSign > 0) return null;
  if (w.status === "open") {
    return sessionGap(x.sessions, w.sinceD, x.d) <= x.params.haltWatchExpirySessions
      ? `open:${w.reasonClass}`
      : null;
  }
  if (w.resumeD === null) return null;
  const gap = sessionGap(x.sessions, w.resumeD, x.d);
  return gap >= 0 && gap < x.params.haltResumeBlockSessions ? `resumed:${w.reasonClass}` : null;
}

/** A watch that should arm the intraday scan today: open and inside the expiry. */
export function armsToday(
  w: HaltWatchView,
  today: string,
  sessions: readonly string[],
  expirySessions: number,
): boolean {
  if (w.status !== "open") return false;
  const gap = sessionGap(sessions, w.sinceD, today);
  return gap >= 1 && gap <= expirySessions; // a notice effective today is the scan's own catalyst
}
