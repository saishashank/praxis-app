// Steelman critic (M11-lite WP3; AGT-133 Critic, LLM-010; D-483). Strict rule: the critic runs on a
// provider other than the author's; if none exists the card is not written. No same-provider fallback.
import type { JsonSchema } from "@/lib/llm/jsonSchema";
import type { LlmProvider } from "@/lib/llm/providers";
import type { Point } from "./claims";

export type CriticChain = { chain: string[]; rule: "different-provider" | "skip" };

const ROLE = "R6" as const;

export function criticChain(
  providers: readonly LlmProvider[],
  author: { provider: string; model: string },
): CriticChain {
  const chain = providers
    .filter((p) => !p.paid && p.available() && p.modelFor(ROLE) !== undefined)
    .filter((p) => p.id !== author.provider)
    .map((p) => p.id);
  return chain.length > 0 ? { chain, rule: "different-provider" } : { chain: [], rule: "skip" };
}

export type Verdict = { pointIndex: number; supported: boolean; note: string };

export const CRITIC_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          pointIndex: { type: "integer" },
          supported: { type: "boolean" },
          note: { type: "string", maxLength: 200 }, // threshold-ok: note length guard
        },
        required: ["pointIndex", "supported", "note"],
      },
    },
  },
  required: ["verdicts"],
};

export function parseVerdicts(v: unknown): { verdicts: Verdict[] } | null {
  const list = v !== null && typeof v === "object" ? (v as { verdicts?: unknown }).verdicts : null;
  if (!Array.isArray(list)) return null;
  const out: Verdict[] = [];
  for (const x of list) {
    const o = x as Record<string, unknown> | null;
    if (
      !o ||
      typeof o.pointIndex !== "number" ||
      typeof o.supported !== "boolean" ||
      typeof o.note !== "string"
    )
      return null;
    out.push({ pointIndex: o.pointIndex, supported: o.supported, note: o.note });
  }
  return { verdicts: out };
}

/**
 * Splits points by the critic's verdicts. A point with no verdict is hidden (the critic must vouch for
 * every shown point); a point marked unsupported is hidden with its note. Index = position in `points`.
 */
export function applyCritic(
  points: readonly Point[],
  verdicts: readonly Verdict[],
): { shown: Point[]; hidden: { point: Point; note: string }[] } {
  const byIndex = new Map<number, Verdict>();
  for (const v of verdicts) if (!byIndex.has(v.pointIndex)) byIndex.set(v.pointIndex, v);
  const shown: Point[] = [];
  const hidden: { point: Point; note: string }[] = [];
  points.forEach((p, i) => {
    const v = byIndex.get(i);
    if (v?.supported === true) shown.push(p);
    else hidden.push({ point: p, note: v ? v.note : "no verdict" });
  });
  return { shown, hidden };
}
