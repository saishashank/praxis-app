// @vitest-environment node
// M22 L5 (D-1415): the minilm_enabled switch guard. With the committed files (no trained head, an unpinned lock) "on" is
// refused in the Owner's words; "off" passes; the guard is registered and reached through switchRefusal; a doubtful input refuses.
import { describe, expect, it } from "vitest";
import { minilmGuard, minilmRefusal } from "@/lib/config/guards/minilm";
import { GUARDS, switchRefusal } from "@/lib/config/switchGuards";
import { MODEL_MISMATCH, NOT_PINNED, NOT_TRAINED } from "@/lib/llm/minilm/head";
import head from "@/lib/llm/minilm/head.weights.json";
import { headOf, lockOf, SHA_B } from "./helpers";

const db = { execute: () => Promise.reject(new Error("the guard reads no database")) };

describe("minilm guard", () => {
  it("is registered", () => {
    expect(GUARDS.minilm_enabled).toBe(minilmGuard);
  });
  it("refuses on while no trained head is committed, passes off", async () => {
    expect(head.trained).toBe(false);
    expect(await minilmGuard(db, "on")).toBe("The local classifier has not been trained yet");
    expect(await switchRefusal(db, "minilm_enabled", "on")).toBe(NOT_TRAINED);
    expect(await switchRefusal(db, "minilm_enabled", "off")).toBeNull();
  });
  it("refuses an unpinned lock, a different model and garbage; passes a trained head on the pinned model", () => {
    expect(minilmRefusal(headOf(), lockOf(null))).toBe(NOT_PINNED);
    expect(minilmRefusal(headOf({ modelSha: SHA_B }), lockOf())).toBe(MODEL_MISMATCH);
    expect(minilmRefusal(undefined, lockOf())).toBe(NOT_TRAINED);
    expect(minilmRefusal(headOf(), null)).toBe(NOT_TRAINED);
    expect(minilmRefusal(headOf(), lockOf())).toBeNull();
  });
});
