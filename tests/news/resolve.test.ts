// M7 T16: the `/news?item=<ann_id>` lookup is for unmasked viewers only (no existence oracle).
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, fullWorld } from "../loaders/world";
import { resolveNewsItemRef } from "@/lib/ui/loaders/news";

afterAll(cleanupTempDbs);

describe("resolveNewsItemRef", () => {
  it("finds an announcement by its source id for the Owner and a granted viewer", async () => {
    const w = await fullWorld();
    expect(await resolveNewsItemRef(envOf(w, "owner"), "n1")).toBe(w.annIds.up);
    expect(await resolveNewsItemRef(envOf(w, "granted"), "n2")).toBe(w.annIds.oth);
    expect(await resolveNewsItemRef(envOf(w, "owner"), "missing")).toBeNull();
    expect(await resolveNewsItemRef(envOf(w, "owner"), "")).toBeNull();
    expect(await resolveNewsItemRef(envOf(w, "owner"), "x".repeat(201))).toBeNull();
  });
  it("answers null for masked users, whether or not the item exists", async () => {
    const w = await fullWorld();
    for (const who of ["editor", "viewer"] as const) {
      expect(await resolveNewsItemRef(envOf(w, who), "n1")).toBeNull();
      expect(await resolveNewsItemRef(envOf(w, who), "missing")).toBeNull();
    }
  });
});
