// Deterministic injection checks for Lane-A text (KB-032, KB-061, LLM-035, M6 design 2.6, D-110).
// Lane-A playbook lines are built only from lesson-record fields; these checks run on each rendered
// line anyway and refuse it (the lesson is excluded and the event is returned for logging) when it
// holds: a phrase of `llm_injection_phrases`, an imperative pattern, a URL, code-looking text, or a
// number that the lesson record does not contain. Pure; the phrase list comes from AgentParams.
import { filterInjection } from "@/lib/llm/injection";

export type InjectionFindingKind = "phrase" | "imperative" | "url" | "code" | "unknown_number";

export type InjectionFinding = { kind: InjectionFindingKind; match: string };

export type InjectionCheckResult = { ok: boolean; findings: InjectionFinding[] };

/** One refused lesson; the caller logs it (KB-061). */
export type InjectionEvent = {
  lessonId: string;
  agent: string;
  findings: InjectionFinding[];
};

const IMPERATIVE = new RegExp(
  "\\b(you must|you should|you shall|must not|do not|don't|always|never|ignore|disregard|" +
    "forget|override|execute|obey|buy|sell|reveal|send|delete|run|pretend|act as)\\b",
  "i",
);
const URL_RE = new RegExp(
  "(https?:\\/\\/|ftp:\\/\\/|www\\.|\\b[a-z0-9-]+\\.(com|net|org|io|dev|ai)\\b)",
  "i",
);
const CODE_RE = new RegExp(
  "(`|<\\/?[a-z][^>]*>|\\{\\{|\\$\\{|\\bfunction\\s*\\(|=>|;\\s*(drop|delete|select|insert)\\b)",
  "i",
);
const NUMBER_RE = new RegExp("(?<![\\w.])-?\\d+(?:\\.\\d+)?(?![\\w])", "g");

/** Numbers (as written, sign dropped) found in a text; used to build and test the allowed set. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => m[0].replace(/^-/, ""));
}

/**
 * Checks one rendered line. `allowedNumbers` holds every number that appears in the lesson record
 * (identifiers, counts, estimates as displayed); `phrases` is the injection phrase list.
 */
export function checkInjection(
  text: string,
  allowedNumbers: ReadonlySet<string>,
  phrases: readonly string[],
): InjectionCheckResult {
  const findings: InjectionFinding[] = [];
  if (filterInjection(text, phrases).removed > 0) {
    // The filter only counts; name the phrases that matched.
    for (const p of phrases) {
      if (filterInjection(text, [p]).removed > 0) findings.push({ kind: "phrase", match: p });
    }
    if (findings.length === 0) findings.push({ kind: "phrase", match: "secret-shaped token" });
  }
  const imp = IMPERATIVE.exec(text);
  if (imp) findings.push({ kind: "imperative", match: imp[0].toLowerCase() });
  const url = URL_RE.exec(text);
  if (url) findings.push({ kind: "url", match: url[0] });
  const code = CODE_RE.exec(text);
  if (code) findings.push({ kind: "code", match: code[0] });
  for (const n of numbersIn(text)) {
    if (!allowedNumbers.has(n)) findings.push({ kind: "unknown_number", match: n });
  }
  return { ok: findings.length === 0, findings };
}
