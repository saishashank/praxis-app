// Playbook renderer (ARN-064, KB-030..032, M6 design 2.6, decisions 9, 11, 12, 22 / D-110).
// Template-only while the classifier is `none` (decision 9): the text is built solely from
// structured lesson fields (template, metric, direction, n, blocks, estimate, grade) by
// `renderPlaybook`; there is no LLM prose and no announcement or third-party input. Two sections,
// "Guidance" (L2/L3) then "Unproven notes" (L0/L1, or forced by the Owner), each ordered by grade
// descending, then |estimate| / half-width descending, then lesson id, truncated at
// `playbook_max_tokens` (the router's estimator). Pure and deterministic.
import { createHash } from "node:crypto";
import { estimateTokens } from "@/lib/llm/budget";
import type { LessonGrade, LessonGradeRow, LessonRow, PlaybookAgent } from "./schema";
import { checkInjection, numbersIn, type InjectionEvent } from "./injectionChecks";

export const GUIDANCE_HEADING = "Guidance";
export const UNPROVEN_HEADING = "Unproven notes";
export const FORCED_LABEL = "forced by Owner";
const DISPLAY_DECIMALS = 4; // threshold-ok: display precision of an estimate, not a rule value

export type PlaybookSection = "guidance" | "unproven";

/** A lesson that Lane A may state, with its current grade row and how it became eligible. */
export type PlaybookItem = {
  lesson: LessonRow;
  grade: LessonGradeRow;
  section: PlaybookSection;
  forcedByOwner: boolean;
};

export type RenderParams = {
  playbookMaxTokens: number;
  injectionPhrases: readonly string[];
};

export type RenderedPlaybook = {
  agent: PlaybookAgent;
  content: string;
  sha: string;
  tokens: number;
  /** Lesson ids stated, in order. */
  included: string[];
  /** Lesson ids left out because of the token cap. */
  dropped: string[];
  /** Lessons refused by the injection checks. */
  excluded: InjectionEvent[];
};

const GRADE_RANK: Record<LessonGrade, number> = { L3: 3, L2: 2, L1: 1, L0: 0, retired: -1 };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fmt(x: number | null): string {
  return x === null ? "n/a" : String(Number(x.toFixed(DISPLAY_DECIMALS)));
}

/** |estimate| divided by the interval half-width (a monotone stand-in for |estimate| / se). */
function strength(g: LessonGradeRow): number {
  if (g.estimate === null || g.lower === null || g.upper === null) return 0;
  const half = (g.upper - g.lower) / 2;
  return half > 0 ? Math.abs(g.estimate) / half : Number.MAX_VALUE;
}

/** Order inside one section: grade desc, strength desc, lesson id. */
export function compareItems(a: PlaybookItem, b: PlaybookItem): number {
  return (
    GRADE_RANK[b.grade.grade] - GRADE_RANK[a.grade.grade] ||
    strength(b.grade) - strength(a.grade) ||
    (a.lesson.id < b.lesson.id ? -1 : a.lesson.id > b.lesson.id ? 1 : 0)
  );
}

function subjectText(json: string): string {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return "";
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "";
  const o = v as Record<string, unknown>;
  return Object.keys(o)
    .sort()
    .filter((k) => ["string", "number", "boolean"].includes(typeof o[k]))
    .map((k) => `${k}=${String(o[k])}`)
    .join(", ");
}

/** The grade a line shows: a guidance lesson reads as L3 (Lane A adopts it when it is stated). */
function shownGrade(item: PlaybookItem): LessonGrade {
  return item.section === "guidance" ? "L3" : item.grade.grade;
}

/** One lesson line, from record fields only. */
export function lessonLine(item: PlaybookItem): string {
  const { lesson: l, grade: g } = item;
  const subject = subjectText(l.subject_json);
  const dir = l.direction === 1 ? "positive" : "negative";
  return [
    `- ${l.id} (${l.template_id} v${l.template_version}): ${l.metric}`,
    subject === "" ? "" : ` for ${subject}`,
    `, ${dir} direction; estimate ${fmt(g.estimate)} (${fmt(g.lower)} to ${fmt(g.upper)}), n=${g.n}, blocks=${g.blocks}, grade ${shownGrade(item)}`,
    item.forcedByOwner ? `, ${FORCED_LABEL}` : "",
    ".",
  ].join("");
}

/** Every number the lesson record holds, as written (the allowed set of the injection check). */
export function allowedNumbersOf(item: PlaybookItem): Set<string> {
  const { lesson: l, grade: g } = item;
  const set = new Set<string>();
  const texts = [
    l.id,
    l.template_id,
    String(l.template_version),
    l.subject_json,
    l.rule_version,
    l.metric,
    l.lineage_id ?? "",
    String(g.n),
    String(g.blocks),
    fmt(g.estimate),
    fmt(g.lower),
    fmt(g.upper),
    shownGrade(item),
  ];
  for (const t of texts) for (const n of numbersIn(t)) set.add(n);
  return set;
}

export function renderPlaybook(
  agent: PlaybookAgent,
  items: readonly PlaybookItem[],
  params: RenderParams,
): RenderedPlaybook {
  const excluded: InjectionEvent[] = [];
  const usable: PlaybookItem[] = [];
  for (const it of items) {
    const res = checkInjection(lessonLine(it), allowedNumbersOf(it), params.injectionPhrases);
    if (res.ok) usable.push(it);
    else excluded.push({ lessonId: it.lesson.id, agent, findings: res.findings });
  }
  const guidance = usable.filter((i) => i.section === "guidance").sort(compareItems);
  const unproven = usable.filter((i) => i.section === "unproven").sort(compareItems);
  const ordered = [...guidance, ...unproven];

  const build = (picked: readonly PlaybookItem[]): string => {
    const g = picked.filter((i) => i.section === "guidance").map(lessonLine);
    const u = picked.filter((i) => i.section === "unproven").map(lessonLine);
    const out = [`# Playbook ${agent}`, ""];
    out.push(`## ${GUIDANCE_HEADING}`, ...(g.length ? g : ["- none"]), "");
    out.push(`## ${UNPROVEN_HEADING}`, ...(u.length ? u : ["- none"]), "");
    return out.join("\n");
  };

  // Greedy in order; a lesson that would break the cap is dropped, a later shorter one may fit.
  const picked: PlaybookItem[] = [];
  const dropped: string[] = [];
  for (const it of ordered) {
    if (estimateTokens(build([...picked, it])) <= params.playbookMaxTokens) picked.push(it);
    else dropped.push(it.lesson.id);
  }
  const content = build(picked);
  return {
    agent,
    content,
    sha: sha256Hex(content),
    tokens: estimateTokens(content),
    included: picked.map((i) => i.lesson.id),
    dropped,
    excluded,
  };
}

/** Unified-style line diff (LCS), stored in change_ledger.diff_text. */
export function unifiedDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}
