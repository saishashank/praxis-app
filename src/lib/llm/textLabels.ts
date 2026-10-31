// CTX-040 text labels and the CTX-041 opinion-tracking hook (M15 P5; D-269, D-270).
//
// Three enumerated labels per price-sensitive announcement (guidance direction, event-type
// confirmation, tone), each with a cited span, produced through the existing LLM router (role R2,
// so the existing role/total/nightly budgets and the LLM-074 reservation apply). They are SHADOW
// ONLY: stored in text_label with produced_at, a model id, the input manifest id and a
// label_validation row; nothing in the score path reads them (static check
// tests/cortex/static/noOpinionReads.test.ts). Off unless the environment is staging.
//
// Note on placement: src/lib/agents/events.ts (A2) is a pure rules table with no LLM call (its
// category_llm / polarity_llm stay NULL, AGT-011a), so the labels run as a separate post-classification
// step that is called from a one-line hook in eventsForDecision, with the same router and budgets.
import { DATAMARK } from "./datamark";
import type { JsonSchema } from "./jsonSchema";
import type { LlmProvider } from "./providers";
import type { LlmRouter } from "./router";
import { enumLabel } from "./labels";
import type { EventRow } from "@/lib/agents/schema";
import type { AnnouncementRow } from "@/lib/agents/decisionView";
import { hashOf, type BatchExec, type Exec, type WriteResult } from "@/lib/cortex/store/common";
import {
  insertLabelWithValidation,
  insertOpinion,
  insertValidation,
  settleOpinion,
  type LabelKind,
  type LabelValidationRow,
  type OpinionRow,
  type TextLabelRow,
} from "@/lib/cortex/store/labels";

export const TEXT_LABEL_TEMPLATE_VERSION = "text-labels-v1";

/** The three CTX-040 enumerations. */
export const LABEL_ENUMS = {
  guidance: ["up", "same", "down", "none"],
  event_confirm: ["confirmed", "contradicted", "unclear"],
  tone: ["negative", "neutral", "positive"],
} as const satisfies Record<LabelKind, readonly string[]>;
export const LABEL_KIND_ORDER: readonly LabelKind[] = ["guidance", "event_confirm", "tone"];

/** Values that may carry no span (nothing to cite); every other value needs a span found in the text. */
const SPANLESS: Readonly<Record<LabelKind, readonly string[]>> = {
  guidance: ["none"],
  event_confirm: ["unclear"],
  tone: [],
};

const MAX_SPAN_CHARS = 300; // threshold-ok: schema size bound on a cited span, not a rule
const MAX_OUTPUT_TOKENS = 200; // threshold-ok: reservation size of the answer
const ID_HEX = 24; // threshold-ok: length of the hash prefix in a validation id
const OPINION_HEX = 12; // threshold-ok: length of the hash suffix in an opinion id

/**
 * The switch (reuses the existing PRAXIS_ENV staging switch; no new key or secret): labels are
 * produced in staging only. PRAXIS_TEXT_LABELS=off turns them off there too.
 */
export function textLabelsEnabled(env: {
  readonly PRAXIS_ENV?: string;
  readonly PRAXIS_TEXT_LABELS?: string;
}): boolean {
  return env.PRAXIS_ENV === "staging" && env.PRAXIS_TEXT_LABELS !== "off";
}

// ---- request ----

type RawLabel = { value: string; span: string | null };
export type RawLabels = Record<LabelKind, RawLabel>;

const labelSchema: JsonSchema = {
  type: "object",
  properties: {
    value: { type: "string", maxLength: 40 }, // threshold-ok: schema bound on an enum label's length
    span: { type: "string", maxLength: MAX_SPAN_CHARS },
  },
  required: ["value"],
  additionalProperties: false,
};
const answerSchema: JsonSchema = {
  type: "object",
  properties: { guidance: labelSchema, event_confirm: labelSchema, tone: labelSchema },
  required: ["guidance", "event_confirm", "tone"],
  additionalProperties: false,
};

const TASK =
  "Label one price-sensitive ASX announcement. Return a JSON object with the keys guidance, event_confirm and tone. " +
  'Each key holds {"value": ..., "span": ...}. Allowed values: guidance in [up, same, down, none] (direction of any ' +
  "forward guidance); event_confirm in [confirmed, contradicted, unclear] (does the text confirm the event type in FACTS); " +
  "tone in [negative, neutral, positive]. span is an exact quotation from DATA that supports the value; " +
  'omit it only for "none" or "unclear".';

export type LabelInput = {
  readonly market: string;
  /** Business date the call is charged to (YYYY-MM-DD). */
  readonly d: string;
  readonly announcementId: string;
  readonly code: string;
  readonly category: string;
  readonly priceSensitive: boolean;
  readonly title: string;
  readonly body?: string;
  readonly manifestId: string;
};

function isRaw(v: unknown): v is RawLabels {
  if (v === null || typeof v !== "object") return false;
  for (const k of LABEL_KIND_ORDER) {
    const x = (v as Record<string, unknown>)[k];
    if (x === null || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    if (typeof o.value !== "string") return false;
    if (o.span !== undefined && o.span !== null && typeof o.span !== "string") return false;
  }
  return true;
}

/** The text the model sees and the spans are checked against. */
export const labelText = (i: Pick<LabelInput, "title" | "body">): string =>
  i.body ? `${i.title}\n${i.body}` : i.title;

/** The router request for one announcement (exported so tests can compute the mock prompt). */
export function buildLabelRequest(i: LabelInput) {
  return {
    role: "R2" as const,
    market: i.market,
    d: i.d,
    nightly: false,
    templateVersion: TEXT_LABEL_TEMPLATE_VERSION,
    task: TASK,
    facts: { announcement_id: i.announcementId, code: i.code, event_category: i.category },
    untrusted: [labelText(i)],
    parse: (v: unknown): RawLabels | null =>
      isRaw(v)
        ? {
            guidance: { value: v.guidance.value, span: v.guidance.span ?? null },
            event_confirm: { value: v.event_confirm.value, span: v.event_confirm.span ?? null },
            tone: { value: v.tone.value, span: v.tone.span ?? null },
          }
        : null,
    schema: answerSchema,
    rules: null as RawLabels | null,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
}

// ---- validation (pure) ----

const collapse = (s: string): string => s.split(DATAMARK).join(" ").replace(/\s+/g, " ").trim();

export type LabelCheck =
  | { ok: true; value: string; span: string | null }
  | { ok: false; reason: "enum" | "span_missing" | "span_not_in_text" };

/** Enum and span-in-text check of one label (the span is compared after whitespace/datamark folding). */
export function checkLabel(kind: LabelKind, raw: RawLabel, text: string): LabelCheck {
  const value = enumLabel(raw.value, LABEL_ENUMS[kind]);
  if (value === null) return { ok: false, reason: "enum" };
  const span = raw.span === null ? "" : collapse(raw.span);
  if (span === "") {
    if (SPANLESS[kind].includes(value)) return { ok: true, value, span: null };
    return { ok: false, reason: "span_missing" };
  }
  if (!collapse(text).includes(span)) return { ok: false, reason: "span_not_in_text" };
  return { ok: true, value, span };
}

// ---- production ----

export type RejectedLabel = {
  readonly labelKind: LabelKind | null;
  readonly validation: LabelValidationRow;
};
export type AcceptedLabel = {
  readonly label: TextLabelRow;
  readonly validation: LabelValidationRow;
};

export type LabelOutcome = {
  readonly status:
    "off" | "not_price_sensitive" | "no_llm" | "budget_exhausted" | "invalid_answer" | "done";
  readonly accepted: readonly AcceptedLabel[];
  readonly rejected: readonly RejectedLabel[];
};

const NONE = (status: LabelOutcome["status"]): LabelOutcome => ({
  status,
  accepted: [],
  rejected: [],
});

export type LabelDeps = {
  readonly router: Pick<LlmRouter, "route">;
  /** Registered providers, to resolve the model id; the provider id is used when absent. */
  readonly providers?: readonly LlmProvider[];
  readonly enabled: boolean;
  readonly now: () => Date;
};

const validationId = (market: string, ann: string, kind: string, at: string, ok: boolean) =>
  `lv-${hashOf([market, ann, kind, at, ok]).slice(0, ID_HEX)}`;

/**
 * Produces the three labels for one price-sensitive announcement. No LLM call and no rows when
 * labels are off or the item is not price-sensitive. A label that fails the enum or span check is
 * not stored; its failed validation record is returned so the caller can persist it.
 */
export async function produceLabels(deps: LabelDeps, i: LabelInput): Promise<LabelOutcome> {
  if (!deps.enabled) return NONE("off");
  if (!i.priceSensitive) return NONE("not_price_sensitive");
  const res = await deps.router.route(buildLabelRequest(i));
  const at = deps.now().toISOString();
  if (res.budgetExhausted) return NONE("budget_exhausted");
  // the provider was called but nothing usable came back (the router fell to the null rules answer)
  const unusable = !res.llmUsed && res.call.tokensIn > 0;
  if (!res.llmUsed && !unusable) return NONE("no_llm");
  const providerId =
    res.source === "cache" ? (res.attempts.at(-1)?.provider ?? "cache") : res.source;
  const model = deps.providers?.find((p) => p.id === providerId)?.modelFor("R2");
  const modelId = model ? `${providerId}/${model}` : providerId;
  const mk = (kind: string, ok: boolean, detail: Record<string, unknown>): LabelValidationRow => ({
    validationId: validationId(i.market, i.announcementId, kind, at, ok),
    market: i.market,
    kind: "paraphrase",
    // The paraphrase tone-shift test itself is not run in shadow (CTX-040 permission gates); this row
    // is the schema / enum / span-in-text check that every shadow label must pass (D-310).
    result: { check: "schema_enum_span", paraphrase_test: "pending", ok, ...detail },
    createdAt: at,
  });
  const raw = res.value;
  if (raw === null || unusable) {
    return {
      status: "invalid_answer",
      accepted: [],
      rejected: [{ labelKind: null, validation: mk("all", false, { reason: "schema" }) }],
    };
  }
  const text = labelText(i);
  const accepted: AcceptedLabel[] = [];
  const rejected: RejectedLabel[] = [];
  for (const kind of LABEL_KIND_ORDER) {
    const c = checkLabel(kind, raw[kind], text);
    if (!c.ok) {
      rejected.push({
        labelKind: kind,
        validation: mk(kind, false, { label_kind: kind, reason: c.reason }),
      });
      continue;
    }
    const validation = mk(kind, true, { label_kind: kind });
    accepted.push({
      validation,
      label: {
        market: i.market,
        announcementId: i.announcementId,
        labelKind: kind,
        modelId,
        producedAt: at,
        value: c.value,
        citedSpan: c.span,
        manifestId: i.manifestId,
        validationId: validation.validationId,
      },
    });
  }
  return { status: "done", accepted, rejected };
}

/** Writes an outcome: each label with its validation row atomically, then the failed records. */
export async function persistLabelOutcome(db: BatchExec, out: LabelOutcome): Promise<void> {
  for (const a of out.accepted) await insertLabelWithValidation(db, a.label, a.validation);
  for (const r of out.rejected) await insertValidation(db, r.validation);
}

/**
 * The A2 hook (passed as EventContext.labelHook): labels a price-sensitive event and persists the
 * result. A failure here never blocks event ingest (shadow organ).
 */
export function makeLabelHook(
  deps: LabelDeps,
  db: BatchExec,
  manifestId: () => string,
  bodyOf?: (a: AnnouncementRow) => string | undefined,
): (row: EventRow, ann: AnnouncementRow) => Promise<void> {
  return async (row, ann) => {
    try {
      const out = await produceLabels(deps, {
        market: row.market,
        d: row.day0_d,
        announcementId: `${row.source}|${row.ann_id}`,
        code: row.code,
        category: row.category,
        priceSensitive: row.price_sensitive === 1,
        title: ann.title,
        body: bodyOf?.(ann),
        manifestId: manifestId(),
      });
      await persistLabelOutcome(db, out);
    } catch {
      // shadow only: swallow, the event row is already built
    }
  };
}

// ---- CTX-041 opinion tracking (hook only; never an input to scoring) ----

export type OpinionInput = {
  readonly market: string;
  readonly kind: OpinionRow["kind"];
  readonly code: string;
  readonly d: string;
  readonly value: unknown;
};

/** Pure: the opinion row for a Committee or steelman output (id = kind, code, day and a hash of the value). */
export function buildOpinion(i: OpinionInput): Omit<OpinionRow, "settledD" | "outcome"> {
  return {
    market: i.market,
    opinionId: `${i.kind}:${i.code}:${i.d}:${hashOf(i.value).slice(0, OPINION_HEX)}`,
    kind: i.kind,
    code: i.code,
    d: i.d,
    value: i.value,
  };
}

/** Records an opinion (a repeat keeps the first). Opinions are tracked and later settled, never scored. */
export function recordOpinion(db: Exec, i: OpinionInput): Promise<WriteResult> {
  return insertOpinion(db, buildOpinion(i));
}

/** Settles a recorded opinion once with its later outcome (batch 3 calls this). */
export const settleRecordedOpinion = settleOpinion;
