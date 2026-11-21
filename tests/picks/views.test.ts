// D-1849: the Picks view dropdown maps every old URL to the same view, and the links keep their old shape.
import { describe, expect, it } from "vitest";
import { pickViewHref, pickViewOf, PICK_VIEWS } from "@/app/(app)/picks/views";

describe("Picks views (D-1849)", () => {
  it("defaults to Today and maps old links to the same view", () => {
    expect(pickViewOf(undefined)).toBe("today");
    expect(pickViewOf("")).toBe("today");
    expect(pickViewOf("today")).toBe("today");
    expect(pickViewOf("nonsense")).toBe("today");
    expect(pickViewOf(["history", "track"])).toBe("today");
    expect(pickViewOf("history")).toBe("history");
    expect(pickViewOf("track")).toBe("track");
  });
  it("builds the same URLs the old tabs used", () => {
    expect(PICK_VIEWS).toEqual(["today", "history", "track"]);
    expect(pickViewHref("today", "balanced")).toBe("/picks?profile=balanced");
    expect(pickViewHref("history", "balanced")).toBe("/picks?profile=balanced&view=history");
    expect(pickViewHref("track", "aggressive")).toBe("/picks?profile=aggressive&view=track");
  });
});
