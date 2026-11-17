// CXA-007 proposals, shadow (M23 T3; D-1636, D-1637, D-1730...D-1739): the envelope a model may answer with, and the one
// strict shape every proposal is checked against. Text that reaches the model (announcement titles) is untrusted data, and so
// is every answer: an answer is data that is checked here and stored as a shadow row, never an instruction. Pure: no store,
// no clock, no model, no network.
import type { JsonSchema } from "@/lib/llm/jsonSchema";
import { ANGLE_CLUSTERS } from "@/lib/cortex/angles/types";

export const PROPOSAL_KINDS = ["angle", "challenger"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const ORIENTATIONS = ["long", "avoid"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];
/** The six score clusters (CTX-011): the only clusters a proposal may name. */
export const PROPOSAL_CLUSTERS: readonly string[] = ANGLE_CLUSTERS;

/** The fields of one proposal, no more and no fewer (D-1637). */
export const ENVELOPE_KEYS: readonly string[] = [
  "cluster",
  "evidence",
  "kind",
  "name",
  "orientation",
  "rule",
];

/** Knowledge-base ids a proposal may cite: KB-001 to KB-099 (the only ids the model is told, so none can be invented). */
const KB_FIRST = 1; // threshold-ok: first knowledge-base id number
const KB_LAST = 99; // threshold-ok: last knowledge-base id number offered
export const KB_EVIDENCE_IDS: readonly string[] = Array.from(
  { length: KB_LAST - KB_FIRST + 1 },
  (_, i) => `KB-${String(i + KB_FIRST).padStart(3, "0")}`,
);
const KB_SET: ReadonlySet<string> = new Set(KB_EVIDENCE_IDS);
export const isKbId = (v: unknown): v is string => typeof v === "string" && KB_SET.has(v);

export const EVIDENCE_MIN = 1; // threshold-ok: a proposal cites at least one entry
export const EVIDENCE_MAX = 5; // threshold-ok: a proposal cites at most five entries
export const NAME_MIN = 3; // threshold-ok: shortest proposal name
export const NAME_MAX = 80; // threshold-ok: longest proposal name (plain words only)
/** Plain words, digits and a few marks: no markup, no link, no control character, no quote or brace. */
export const NAME_PATTERN = new RegExp(
  `^[A-Za-z][A-Za-z0-9 ,.()&/-]{${NAME_MIN - 1},${NAME_MAX - 1}}$`,
);

/** The most text one raw item may hold before it is read at all (the stored rule is further capped by the table at 4,000). */
export const ITEM_MAX_CHARS = 8000; // threshold-ok: bound on the serialised size of one raw answer item
export const RULE_MAX_CHARS = 3500; // threshold-ok: leaves room for the name inside the 4,000-character column
/** Items read from one answer, whatever the monthly limit: a longer list is cut before anything is looked at. */
export const MAX_RAW_ITEMS = 20; // threshold-ok: bound on the answer list (the limit key is at most 10)
export const PER_PROPOSAL_TOKENS = 1200; // threshold-ok: output tokens reserved for one proposal
export const BASE_OUTPUT_TOKENS = 600; // threshold-ok: output tokens reserved for the wrapper of the answer

/**
 * What the router checks on every answer (LLM-071): the wrapper only. Each item is checked one by one afterwards by
 * `validateProposal`, so one bad item is refused and recorded without discarding the others.
 */
export const RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { proposals: { type: "array", items: { type: "object" } } },
  required: ["proposals"],
  additionalProperties: false,
};

export type ProposalList = { readonly proposals: readonly unknown[] };

/** The router's `parse`: the wrapper has exactly one key, `proposals`, an array within the bound; else null. */
export function parseProposalList(v: unknown): ProposalList | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1 || keys[0] !== "proposals") return null;
  const list = o.proposals;
  if (!Array.isArray(list) || list.length > MAX_RAW_ITEMS) return null;
  return { proposals: list };
}

/** A proposal that passed every check (the only thing that is ever stored with its rule). */
export type Envelope = {
  readonly kind: ProposalKind;
  readonly name: string;
  readonly rule: Readonly<Record<string, unknown>>;
  readonly orientation: Orientation;
  readonly cluster: string;
  readonly evidence: readonly string[];
};

export const REFUSED_STATES = [
  "refused_schema",
  "refused_duplicate",
  "refused_weight",
  "refused_hostile",
] as const;
export type RefusedState = (typeof REFUSED_STATES)[number];
