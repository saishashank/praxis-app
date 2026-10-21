// Canonical JSON and hashes for picks (deterministic: sorted keys, bigint as text).
import { createHash } from "node:crypto";

function canon(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, canon(o[k])]),
    );
  }
  return v;
}

export const canonicalJson = (v: unknown): string => JSON.stringify(canon(v));
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
