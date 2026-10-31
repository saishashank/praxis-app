// Email keys and slot rules (M5 T3, design 2.3 and 2.4, EML-010, NFR-006). One email per key.
//   review:<d>  p0:<alert_key>  p0b:<first_alert_key>  inc:<incident_id>:open|s1  tokens:<d>
//   unread7:<d>  reminder:<d>  brief:<d>  test:<d>:<n>  dbdown:<d>:<slot>
import type { EmailKind, EmailSlot } from "@/lib/sentinel/schema";

const D = "\\d{4}-\\d{2}-\\d{2}";
const KEY_PATTERNS: Record<EmailKind, RegExp> = {
  review: new RegExp(`^review:${D}$`),
  p0: /^p0:.{1,200}$/,
  p0_batch: /^p0b:.{1,200}$/,
  incident_open: /^inc:[^:\s]{1,80}:open$/,
  incident_s1: /^inc:[^:\s]{1,80}:s1$/,
  tokens: new RegExp(`^tokens:${D}$`),
  unread7: new RegExp(`^unread7:${D}$`),
  reminder: new RegExp(`^reminder:${D}$`),
  brief: new RegExp(`^brief:${D}$`),
  test: new RegExp(`^test:${D}:[1-9]\\d?$`),
  dbdown: new RegExp(`^dbdown:${D}:[A-Za-z0-9_-]{1,20}$`),
  // M17 (D-381..D-400): pick alerts. Patterns only here; builders and slots are WP4's.
  pick_hit: new RegExp(`^pickhit:[0-9a-f]{8,64}:${D}$`),
  pick_cleared: new RegExp(`^pickclr:[0-9a-f]{8,64}:${D}$`),
  pick_candidate: new RegExp(`^pickcand:[A-Z]{2}:${D}:[A-Za-z0-9.-]{1,12}$`),
  pick_batch: new RegExp(`^pickb:[^:\\s]{1,80}:${D}:\\d{4}$`),
  pick_digest: new RegExp(`^pickdg:[^:\\s]{1,80}:${D}$`),
};

export const emailKeys = {
  review: (d: string) => `review:${d}`,
  p0: (alertKey: string) => `p0:${alertKey}`,
  p0Batch: (firstAlertKey: string) => `p0b:${firstAlertKey}`,
  incidentOpen: (id: string) => `inc:${id}:open`,
  incidentS1: (id: string) => `inc:${id}:s1`,
  tokens: (d: string) => `tokens:${d}`,
  unread7: (d: string) => `unread7:${d}`,
  reminder: (d: string) => `reminder:${d}`,
  brief: (d: string) => `brief:${d}`,
  test: (d: string, n: number) => `test:${d}:${n}`,
  dbdown: (d: string, slot: string) => `dbdown:${d}:${slot}`,
} as const;

/** True when `key` is a well-formed key of that kind (a typo can never claim another kind's slot). */
export function keyMatchesKind(kind: EmailKind, key: string): boolean {
  return KEY_PATTERNS[kind].test(key);
}

/**
 * The slots a kind may take, in order (design 2.3). Review, incident and reminder have a reserved
 * slot; only the first new incident email of a day gets the reserved one, later ones use the pool.
 * P0 mail never uses a reserved slot (NFR-006 l.21).
 */
export function slotCandidates(kind: EmailKind): readonly EmailSlot[] {
  switch (kind) {
    case "review":
      return ["reserved_review"];
    case "reminder":
      return ["reserved_reminder"];
    case "incident_open":
    case "incident_s1":
      return ["reserved_incident", "pool"];
    case "p0":
    case "p0_batch":
      return ["p0"];
    default:
      return ["pool"];
  }
}

/** Reserved-slot mail and S1 incidents still go out after the monthly cap (decision 25). */
export function monthlyCapExempt(kind: EmailKind, slot: EmailSlot): boolean {
  return slot.startsWith("reserved_") || kind === "incident_s1";
}

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Melbourne calendar date (YYYY-MM-DD) of an instant. */
export function melbourneDate(at: Date): string {
  const p = Object.fromEntries(dateFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Keys of records that explain a suppression without consuming the real key (D-099). */
export const suppressedKey = (key: string, why: "off" | "paused" | "no_recipient") =>
  `${key}~${why}`;

const KEY_DATE = /^(?:review|tokens|unread7|reminder|brief|test|dbdown):(\d{4}-\d{2}-\d{2})/;

/** The local date written in a dated key (review:<d>, ...), else null. */
export function dateInKey(key: string): string | null {
  return KEY_DATE.exec(key)?.[1] ?? null;
}
