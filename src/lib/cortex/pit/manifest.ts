// The immutable input manifest of one night (CTX-010; design 3 `input_manifest`, 3a InputManifest).
// `manifestId` is the sha256 of the canonical JSON of everything else, through the same helpers the
// arena uses for `params_json` (cohort.ts canonicalJson / sha256Hex, D-278): same inputs, same id.
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { INPUT_KINDS, type InputManifest, type ManifestSource } from "./types";

const KIND_ORDER = new Map(INPUT_KINDS.map((k, i) => [k, i] as const));

/** Sources in InputKind order, one row per kind (missing kinds count zero rows). */
export function normaliseSources(sources: readonly ManifestSource[]): ManifestSource[] {
  const byKind = new Map(sources.map((s) => [s.kind, s] as const));
  if (byKind.size !== sources.length) throw new RangeError("duplicate manifest source kind");
  return INPUT_KINDS.map((kind) => byKind.get(kind) ?? { kind, rows: 0, lastKnownAt: null });
}

export function manifestBody(m: Omit<InputManifest, "manifestId">): string {
  return canonicalJson({
    market: m.market,
    d: m.d,
    schemaSha: m.schemaSha,
    sources: normaliseSources(m.sources).map((s) => ({
      kind: s.kind,
      rows: s.rows,
      lastKnownAt: s.lastKnownAt,
    })),
  });
}

export function manifestIdOf(m: Omit<InputManifest, "manifestId">): string {
  return sha256Hex(manifestBody(m));
}

export function buildManifest(m: Omit<InputManifest, "manifestId">): InputManifest {
  const sources = normaliseSources(m.sources).sort(
    (a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!,
  );
  return { manifestId: manifestIdOf(m), market: m.market, d: m.d, schemaSha: m.schemaSha, sources };
}
