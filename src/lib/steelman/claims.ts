// Steelman claim validation (M11-lite WP3; AGT-133, LLM-064, LLM-065; D-487, D-498). Pure and app-side:
// the router has no claim stage, so the one-repair hook (`check()`) is fed from here.
// A point is kept only when every citation is a pack item id, every number is verbatim in a cited item,
// the text is within the word limit and carries no URL, code, instruction or certainty wording.
import { normalizeNumber } from "@/lib/llm/grounding";
import { DEFAULT_INJECTION_PHRASES } from "@/lib/llm/injection";
import type { JsonSchema } from "@/lib/llm/jsonSchema";
/** Structural: any pack-shaped value (the golden fixtures carry plain strings for kind). */
export type PackLike = { items: readonly { id: string; text: string }[] };
import type { PointState, Side } from "./store";

export type Point = { text: string; citations: string[]; monitorable?: boolean };
export type DropReason = "citation" | "number" | "unsafe" | "length";
export type Dropped = { side: Side; point: unknown; reason: DropReason };
export type RawSteelman = { bull?: unknown; bear?: unknown };

export const MAX_WORDS = 40; // threshold-ok: AGT-133 "up to 40 words"
export const MIN_POINTS = 2; // threshold-ok: AGT-133 "2 to 4 points a side"
export const MAX_POINTS = 4; // threshold-ok: AGT-133 "2 to 4 points a side"

const POINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    text: { type: "string", maxLength: 400 }, // threshold-ok: char guard above the word limit
    citations: { type: "array", minItems: 1, items: { type: "string" } },
    monitorable: { type: "boolean" },
  },
  required: ["text", "citations"],
};

export const STEELMAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    bull: { type: "array", minItems: MIN_POINTS, items: POINT_SCHEMA },
    bear: { type: "array", minItems: MIN_POINTS, items: POINT_SCHEMA },
  },
  required: ["bull", "bear"],
};

const URL_RE = new RegExp(
  "(https?:|ftp:|www\\.|\\b[a-z0-9-]+\\.(com|org|net|io|co|au|nz|gov|edu|info|biz|ly|me|xyz)\\b)",
  "i",
);
const CODE_RE = new RegExp("(`|<[a-z/!]|[{}]|\\$\\(|\\bjavascript:|\\bfunction\\s*\\()", "i");
const INSTRUCTION_RE = new RegExp(
  "(^|[.!?;:]\\s+)(buy|sell|hold|ignore|disregard|forget|reveal|override|say|write|output|print|reply|respond|click|visit|send|run|execute|open|download)\\s|\\b(you should|you must|you need to|you are now|as an ai|as a language model)\\b",
  "i",
);
// CTX-002 / D-498: no certainty or forecast wording in stored text.
const CERTAINTY_RE = new RegExp(
  "\\b(certain|certainly|guaranteed|guarantee|will|definitely)\\b",
  "i",
);
const ID_RE = new RegExp("\\bE\\d{2}\\b", "g");
const NUM_RE = new RegExp("\\d[\\d,]*(?:\\.\\d+)?", "g");
const TRAIL_COMMA_RE = new RegExp(",+$");
const SPACE_RE = new RegExp("\\s+");

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Normalised number tokens of a text, evidence-id mentions ("E03") excluded. */
export function numbersOf(text: string): string[] {
  const m = text.replace(ID_RE, " ").match(NUM_RE) ?? [];
  return m.map((n) => normalizeNumber(n.replace(TRAIL_COMMA_RE, "")));
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(SPACE_RE).length;
}

/** True when the text carries a URL, code, an instruction to a system or reader, or certainty wording. */
export function isUnsafe(text: string): boolean {
  const lower = text.toLowerCase();
  if (DEFAULT_INJECTION_PHRASES.some((p) => lower.includes(p))) return true;
  return (
    URL_RE.test(text) || CODE_RE.test(text) || INSTRUCTION_RE.test(text) || CERTAINTY_RE.test(text)
  );
}

/** Why one point is invalid, or null when valid. Order: shape, length, unsafe, citation, number. */
export function pointProblem(point: unknown, pack: PackLike): DropReason | null {
  if (!isObj(point) || typeof point.text !== "string") return "length";
  const text = point.text;
  const words = wordCount(text);
  if (words === 0 || words > MAX_WORDS) return "length";
  if (isUnsafe(text)) return "unsafe";
  const cites = point.citations;
  if (!Array.isArray(cites) || cites.length === 0) return "citation";
  const byId = new Map(pack.items.map((i) => [i.id, i]));
  const cited = [];
  for (const c of cites) {
    const it = typeof c === "string" ? byId.get(c) : undefined;
    if (!it) return "citation";
    cited.push(it);
  }
  const allowed = new Set(cited.flatMap((i) => numbersOf(i.text)));
  if (numbersOf(text).some((n) => !allowed.has(n))) return "number";
  return null;
}

export type Validated = {
  kept: { bull: Point[]; bear: Point[] };
  dropped: Dropped[];
  /** Over half dropped, or a side left with fewer than 2 points (LLM-064): repair once, then omit. */
  rejected: boolean;
};

export function validatePoints(raw: unknown, pack: PackLike): Validated {
  const kept = { bull: [] as Point[], bear: [] as Point[] };
  const dropped: Dropped[] = [];
  const r: RawSteelman = isObj(raw) ? raw : {};
  for (const side of ["bull", "bear"] as const) {
    const list = Array.isArray(r[side]) ? (r[side] as unknown[]) : [];
    for (const p of list) {
      const why = kept[side].length >= MAX_POINTS ? "length" : pointProblem(p, pack);
      if (why !== null) {
        dropped.push({ side, point: p, reason: why });
        continue;
      }
      const o = p as Point;
      const point: Point = { text: o.text.trim(), citations: [...new Set(o.citations)] };
      if (side === "bear") point.monitorable = o.monitorable === true;
      kept[side].push(point);
    }
  }
  const nKept = kept.bull.length + kept.bear.length;
  const rejected =
    nKept + dropped.length === 0 ||
    dropped.length > nKept ||
    kept.bull.length < MIN_POINTS ||
    kept.bear.length < MIN_POINTS;
  return { kept, dropped, rejected };
}

/** Router `check()` (LLM-074, D-487): a response that would be rejected names the side to repair. */
export function steelmanCheck(
  pack: PackLike,
): (value: RawSteelman) => { ok: true } | { ok: false; field: Side } {
  return (value) => {
    const v = validatePoints(value, pack);
    if (!v.rejected) return { ok: true };
    const drops = (s: Side) => v.dropped.filter((d) => d.side === s).length;
    const short = (s: Side) => v.kept[s].length < MIN_POINTS;
    let field: Side;
    if (short("bull") && !short("bear")) field = "bull";
    else if (short("bear") && !short("bull")) field = "bear";
    else field = drops("bull") > drops("bear") ? "bull" : "bear";
    return { ok: false, field };
  };
}

/** The stored state of a dropped point (steelman_point.state). */
export function reasonState(reason: DropReason): PointState {
  if (reason === "citation") return "dropped_citation";
  if (reason === "number") return "dropped_number";
  return "dropped_unsafe";
}
