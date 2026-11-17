// The paraphrase tone-shift harness (M23 T1; CXA-008, CTX-040, D-1636, D-1662). The label route is run over fixed
// synthetic items; each has an original text, a neutral paraphrase (same meaning) and a tone-flipped paraphrase (opposite
// meaning). Stability = the share of items whose three labels do not change on the neutral paraphrase; flip = the share
// whose tone does change on the tone-flipped one. The run passes when stability >= 0.90 and flip >= 0.80 (D-1636). The
// model's answers are data: they are compared as enumerated values and nothing in a text can change what is scored or
// written. With no live R2 nothing is called and nothing is written. One `label_validation` row of kind `paraphrase` per run.
import { hashOf, type Exec } from "@/lib/cortex/store/common";
import { insertValidation, type LabelValidationRow } from "@/lib/cortex/store/labels";
import { askLabels, type AskedLabels, type LabelInput } from "@/lib/llm/textLabels";
import type { LlmRouter } from "@/lib/llm/router";

/** D-1636 [PROPOSED]: the neutral-paraphrase stability needed to pass. */
export const STABILITY_MIN = 0.9; // threshold-ok: D-1636 pre-registered harness threshold, listed for the Owner
/** D-1636 [PROPOSED]: the share of tone-flipped paraphrases whose tone must change. */
export const FLIP_MIN = 0.8; // threshold-ok: D-1636 pre-registered harness threshold, listed for the Owner
const ID_HEX = 24; // threshold-ok: length of the hash prefix in a validation id

export type ParaphraseItem = {
  readonly id: string;
  readonly original: string;
  readonly neutral: string;
  readonly flipped: string;
};

export type ParaphraseDeps = {
  readonly router: Pick<LlmRouter, "route">;
  /** Whether the factory lists R2 live (`r2IsLive`); false means nothing is called. */
  readonly r2Live: boolean;
  readonly market: string;
  /** Business date the calls are charged to (YYYY-MM-DD). */
  readonly d: string;
  readonly now: () => Date;
};

export type ParaphraseRun =
  | { readonly status: "no_live_role" }
  | {
      readonly status: "incomplete";
      readonly reason: "budget_exhausted" | "no_llm";
      readonly done: number;
    }
  | {
      readonly status: "done";
      readonly items: number;
      readonly stability: number;
      readonly flip: number;
      readonly passed: boolean;
      /** Items with an invalid or unusable answer: counted unstable (neutral) and as no flip (tone-flipped). */
      readonly invalid: number;
      readonly validation: LabelValidationRow;
    };

const input = (
  deps: ParaphraseDeps,
  it: ParaphraseItem,
  text: string,
  tag: string,
): LabelInput => ({
  market: deps.market,
  d: deps.d,
  announcementId: `paraphrase|${it.id}|${tag}`,
  code: "ZZ",
  category: "guidance",
  priceSensitive: true,
  title: text,
  manifestId: "paraphrase-harness",
});

const stops = (a: AskedLabels): a is { status: "budget_exhausted" | "no_llm" } =>
  a.status === "budget_exhausted" || a.status === "no_llm";

/** Runs the harness. Calls nothing, and returns no row, unless R2 is live. */
export async function runParaphrase(
  deps: ParaphraseDeps,
  items: readonly ParaphraseItem[],
): Promise<ParaphraseRun> {
  if (!deps.r2Live) return { status: "no_live_role" };
  let stable = 0;
  let flipped = 0;
  let invalid = 0;
  let done = 0;
  for (const it of items) {
    const base = await askLabels(deps.router, input(deps, it, it.original, "o"));
    if (stops(base)) return { status: "incomplete", reason: base.status, done };
    const neutral = await askLabels(deps.router, input(deps, it, it.neutral, "n"));
    if (stops(neutral)) return { status: "incomplete", reason: neutral.status, done };
    const flip = await askLabels(deps.router, input(deps, it, it.flipped, "f"));
    if (stops(flip)) return { status: "incomplete", reason: flip.status, done };
    done += 1;
    if (base.status !== "done" || neutral.status !== "done" || flip.status !== "done") invalid += 1;
    if (base.status === "done" && neutral.status === "done") {
      const same =
        base.values.guidance === neutral.values.guidance &&
        base.values.event_confirm === neutral.values.event_confirm &&
        base.values.tone === neutral.values.tone;
      if (same) stable += 1;
    }
    if (base.status === "done" && flip.status === "done" && base.values.tone !== flip.values.tone) {
      flipped += 1;
    }
  }
  const n = items.length;
  const stability = n === 0 ? 0 : stable / n;
  const flipRate = n === 0 ? 0 : flipped / n;
  const passed = n > 0 && stability >= STABILITY_MIN && flipRate >= FLIP_MIN;
  const at = deps.now().toISOString();
  const validation: LabelValidationRow = {
    validationId: `lp-${hashOf([deps.market, deps.d, at, n, stable, flipped]).slice(0, ID_HEX)}`,
    market: deps.market,
    kind: "paraphrase",
    result: {
      check: "paraphrase_harness",
      paraphrase_test: passed ? "pass" : "fail",
      items: n,
      stability,
      flip: flipRate,
      invalid,
      stability_min: STABILITY_MIN,
      flip_min: FLIP_MIN,
    },
    createdAt: at,
  };
  return { status: "done", items: n, stability, flip: flipRate, passed, invalid, validation };
}

/** Writes the run's one validation row (nothing for a run that did not finish). Returns whether a row was written. */
export async function persistParaphraseRun(db: Exec, run: ParaphraseRun): Promise<boolean> {
  if (run.status !== "done") return false;
  await insertValidation(db, run.validation);
  return true;
}
