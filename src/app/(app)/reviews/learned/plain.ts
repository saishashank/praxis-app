// Plain wording for "What the system learned": strategy-family names instead of F1..F7, document titles
// built from the kind and day, and the learning plan lines without check ids, lane names or repeated
// prefixes. Pure functions, no I/O.
import { familyBadge } from "@/lib/ui/familyBadge";
import { formatCount, formatDay, plural } from "@/lib/view/format";

/** "F1" -> "Breakout"; a code that is not a family is returned as it is. */
export function familyName(code: string): string {
  const b = familyBadge(code);
  return b.label === "Pick" && !/^(F\d|ID)$/.test(code) ? code : b.label;
}

const DOC_LABEL: Record<string, string> = {
  family: "Strategy family",
  playbook: "Playbook",
  lesson: "Lesson",
  challenger: "Challenger",
  review: "Evening review",
  hypothesis: "Hypothesis",
  source_register: "Data sources",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WEEK = /^\d{4}-W\d{2}$/;

/**
 * A readable title for a document with no title of its own: "Evening review, Thu 22 Oct". `day` is the
 * stored ISO date, or an ISO week for a masked user (then "Evening review, week 2026-W43").
 */
export function documentTitle(docType: string, day: string | null, masked: boolean): string {
  const label =
    DOC_LABEL[docType] ?? docType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (day === null) return label;
  if (ISO_WEEK.test(day) || masked) return `${label}, week ${ISO_WEEK.test(day) ? day : "n/a"}`;
  return ISO_DAY.test(day) ? `${label}, ${formatDay(day)}` : label;
}

const KIND_LABEL: Record<string, string> = {
  lane_a_change: "Rule change",
  challenger_step: "Challenger",
  l2_reachable: "Ready for the next test",
  data_weakness: "Data check",
  finding_look: "Finding to confirm",
};

/** Every ISO date inside a sentence becomes "Mon 9 Nov". */
const plainDays = (s: string): string => s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => formatDay(d));

/**
 * One plan line, plain: the heading ("Data check") and the text, with no repeated "data_weakness:"
 * prefix, no check ids ("DAT-200:no_trade") and no lane names.
 */
export function plainPlanItem(kind: string, reason: string): { heading: string; text: string } {
  const heading = KIND_LABEL[kind] ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  let r = reason.replace(/^no-lesson:/, "").trim();
  // a prefix that repeats the kind: "data_weakness: ..." or "data weakness: ..."
  r = r.replace(new RegExp(`^(${kind}|${kind.replace(/_/g, " ")}):\\s*`, "i"), "");
  r = r.replace(/\s*\(lane [^)]*\)\s*$/i, "");
  const flags = /^(\d[\d,]*) open data-quality flags? of check ([A-Za-z0-9-]+)(?::(\S+))?/.exec(r);
  if (flags) {
    const n = Number(flags[1]!.replace(/,/g, ""));
    const what = flags[3] === "no_trade" ? "with no trades" : "";
    const subject = what ? plural(n, "day") : plural(n, "item");
    return {
      heading,
      text: `${formatCount(n)} ${subject} ${what ? `${what} ` : ""}flagged for review`.replace(
        /\s+/g,
        " ",
      ),
    };
  }
  const source = /^source (\S+) is (\w+)$/.exec(r);
  if (source) {
    const mode = source[2] === "off" ? "switched off" : source[2]!;
    return { heading, text: `The ${source[1]!.replace(/_/g, " ")} data source is ${mode}` };
  }
  return { heading, text: plainDays(r).replace(/^./, (c) => c.toUpperCase()) };
}
