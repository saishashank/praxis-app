// CXA-007 validation (M23 T3; D-1637, D-1730...D-1734). One raw item of a model answer in, one verdict out. The raw item is
// untrusted: it is only read, never run, merged into another object or written as it came. The order is fixed and every check
// is deterministic:
//   1. size (an item over the cap is refused before anything reads it);
//   2. hostile: an injection phrase or a secret-shaped token anywhere in the item, or a link, markup, control or invisible
//      character in a text field (`refused_hostile`);
//   3. weight: a key at any depth, or a word in the name, that names a weight, a threshold, a size, the active set or a rule
//      version (`refused_weight`). The rule grammar itself requires one `size` action (FAM-001, the family's fixed shape with
//      no number in it); it is a grammar word, not a size, and is carried unchanged;
//   4. shape: exactly the six fields, each of its type and range (`refused_schema`);
//   5. grammar: the rule passes `validateRuleSpec` (`refused_schema`);
//   6. duplicate: the canonical hash of the rule equals a known rule, or the name equals a registered angle's id or title or an
//      earlier proposal's name (`refused_duplicate`).
// A refused item yields a state and a fixed reason only; none of its text is carried on. Pure.
import { ANGLES } from "@/lib/cortex/angles/registry";
import { validateRuleSpec } from "@/lib/agents/families/ruleSchema";
import { filterInjection } from "@/lib/llm/injection";
import { canonicalJson, sha256Hex } from "../registry";
import {
  EVIDENCE_MAX,
  EVIDENCE_MIN,
  ENVELOPE_KEYS,
  ITEM_MAX_CHARS,
  NAME_PATTERN,
  ORIENTATIONS,
  PROPOSAL_CLUSTERS,
  PROPOSAL_KINDS,
  RULE_MAX_CHARS,
  isKbId,
  type Envelope,
  type Orientation,
  type ProposalKind,
  type RefusedState,
} from "./schema";

export type Verdict =
  | { readonly state: "stored"; readonly envelope: Envelope; readonly ruleSha: string }
  | { readonly state: RefusedState; readonly why: string };

/** What a new proposal is compared with. Mutated as a batch is accepted, so two copies in one answer are one proposal. */
export type Known = { readonly ruleShas: Set<string>; readonly names: Set<string> };

const MAX_DEPTH = 12; // threshold-ok: deepest nesting read in one item (the grammar nests far less)

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Names compare by letters and digits only, lower case: "A-D3-01", "a d3 01" and "AD301" are one name. */
export const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The names of every registered angle (its id and its title), as comparison keys (K10). */
export function registeredAngleNames(): Set<string> {
  const out = new Set<string>();
  for (const a of ANGLES) {
    out.add(nameKey(a.id));
    out.add(nameKey(a.title));
  }
  return out;
}

/** The canonical hash of a rule: key order and spacing do not matter. */
export const ruleShaOf = (rule: unknown): string => sha256Hex(canonicalJson(rule));

/** Every string of a value, keys included, to a bounded depth; false when the value nests deeper than the bound. */
function strings(v: unknown, out: string[], depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) {
    for (const x of v) if (!strings(x, out, depth + 1)) return false;
  } else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      out.push(k);
      if (!strings(v[k], out, depth + 1)) return false;
    }
  }
  return true;
}

/** Every key of every object of a value, to a bounded depth. */
function keysOf(v: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(v)) for (const x of v) keysOf(x, out, depth + 1);
  else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      out.push(k);
      keysOf(v[k], out, depth + 1);
    }
  }
}

const URL_OR_MARKUP = new RegExp("(https?:|ftp:|www\\.|[<>`{}\\\\])", "i");
const CONTROL_OR_INVISIBLE = new RegExp(
  "[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufeff]",
);

/** Fields whose text is free (not a grammar word): where a link or markup is hostile. */
function freeText(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["name", "cluster", "kind", "orientation"]) {
    if (typeof o[k] === "string") out.push(o[k] as string);
  }
  if (Array.isArray(o.evidence)) for (const e of o.evidence) if (typeof e === "string") out.push(e);
  return out;
}

function isHostile(raw: unknown): boolean {
  const all: string[] = [];
  if (!strings(raw, all, 0)) return true;
  for (const s of all) {
    if (filterInjection(s).removed > 0) return true;
    if (CONTROL_OR_INVISIBLE.test(s)) return true;
  }
  if (isObj(raw)) for (const s of freeText(raw)) if (URL_OR_MARKUP.test(s)) return true;
  return false;
}

/** Key names (lower case, letters and digits only) that name a weight, threshold, size, the active set or a rule version. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "weight",
  "weights",
  "weighting",
  "threshold",
  "thresholds",
  "size",
  "sizes",
  "sizing",
  "positionsize",
  "active",
  "activeset",
  "ruleversion",
  "ruleversions",
  "version",
]);
const FORBIDDEN_KEY_PARTS: readonly string[] = ["weight", "threshold", "activeset", "ruleversion"];
const FORBIDDEN_WORDS = new RegExp(
  "\\b(weights?|weighting|thresholds?|sizes?|sizing|active set|rule versions?)\\b",
  "i",
);

function namesAWeight(raw: unknown): boolean {
  const keys: string[] = [];
  keysOf(raw, keys, 0);
  for (const k of keys) {
    const n = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_KEYS.has(n) || FORBIDDEN_KEY_PARTS.some((p) => n.includes(p))) return true;
  }
  if (isObj(raw)) {
    if (typeof raw.name === "string" && FORBIDDEN_WORDS.test(raw.name)) return true;
  }
  return false;
}

function shapeOf(o: Record<string, unknown>): Envelope | null {
  const keys = Object.keys(o).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i]))
    return null;
  const { kind, name, rule, orientation, cluster, evidence } = o;
  if (typeof kind !== "string" || !(PROPOSAL_KINDS as readonly string[]).includes(kind))
    return null;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) return null;
  if (!isObj(rule)) return null;
  if (typeof orientation !== "string" || !(ORIENTATIONS as readonly string[]).includes(orientation))
    return null;
  if (typeof cluster !== "string" || !PROPOSAL_CLUSTERS.includes(cluster)) return null;
  if (!Array.isArray(evidence) || evidence.length < EVIDENCE_MIN || evidence.length > EVIDENCE_MAX)
    return null;
  if (!evidence.every(isKbId) || new Set(evidence).size !== evidence.length) return null;
  if (canonicalJson(rule).length > RULE_MAX_CHARS) return null;
  return {
    kind: kind as ProposalKind,
    name,
    rule,
    orientation: orientation as Orientation,
    cluster,
    evidence: [...(evidence as string[])].sort(),
  };
}

/** Checks one raw item. `known` is read, not changed (the batch function adds an accepted item to it). */
export function validateProposal(raw: unknown, known: Known): Verdict {
  let size = Number.POSITIVE_INFINITY;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  if (size > ITEM_MAX_CHARS) return { state: "refused_schema", why: "the item is too large" };
  if (isHostile(raw)) return { state: "refused_hostile", why: "text that reads as an instruction" };
  if (namesAWeight(raw)) {
    return {
      state: "refused_weight",
      why: "names a weight, threshold, size, active set or version",
    };
  }
  if (!isObj(raw)) return { state: "refused_schema", why: "not an object" };
  const env = shapeOf(raw);
  if (env === null) return { state: "refused_schema", why: "outside the proposal shape" };
  if (validateRuleSpec(env.rule).length > 0)
    return { state: "refused_schema", why: "outside the rule grammar" };
  const ruleSha = ruleShaOf(env.rule);
  if (known.ruleShas.has(ruleSha))
    return { state: "refused_duplicate", why: "the rule is already known" };
  if (known.names.has(nameKey(env.name)))
    return { state: "refused_duplicate", why: "the name is already taken" };
  return { state: "stored", envelope: env, ruleSha };
}

/** Checks a list in order; an accepted item is added to `known` so a copy later in the list is a duplicate. */
export function validateBatch(raws: readonly unknown[], known: Known): Verdict[] {
  const out: Verdict[] = [];
  for (const raw of raws) {
    const v = validateProposal(raw, known);
    if (v.state === "stored") {
      known.ruleShas.add(v.ruleSha);
      known.names.add(nameKey(v.envelope.name));
    }
    out.push(v);
  }
  return out;
}
