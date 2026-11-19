// The MiniLM switch guard (minilm_enabled, D-946, D-1445; M22 L5, D-1415): "on" is refused while no trained head is committed,
// while the pinned model has no fingerprint yet, or while the committed head was trained on another model file than the pinned
// one. Pure over two committed JSON files (no database read, no model file, no runtime import); any doubt refuses. "off" and
// every other value pass.
import type { Guard } from "../switchGuards";
import { readinessProblem, type Head, type MinilmLock } from "@/lib/llm/minilm/head";
import headJson from "@/lib/llm/minilm/head.weights.json";
import lockJson from "@/lib/llm/minilm/model.lock.json";

/** Null when the small reader may be switched on with this head and lock, else the refusal text. */
export function minilmRefusal(head: unknown, lock: unknown): string | null {
  try {
    return readinessProblem(head, lock as MinilmLock);
  } catch {
    return "The local classifier has not been trained yet";
  }
}

export const minilmGuard: Guard = async (_db, value) =>
  value === "on" ? minilmRefusal(headJson as unknown as Head, lockJson) : null;
