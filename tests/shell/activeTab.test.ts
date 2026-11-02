import { describe, expect, it } from "vitest";
import { activeTabOf } from "@/lib/ui/activeTab";
import { ROUTES, activeTab } from "@/lib/ui/nav";

describe("activeTabOf (client TabBar) equals activeTab (nav model)", () => {
  const concrete = ROUTES.map((r) => r.pattern.replace(/\[[^\]]+\]/g, "x"));
  const extra = [
    "/picks/unknown/deeper/still",
    "/alerts/foo",
    "/cards",
    "/cards/1/2",
    "/cortex/x",
    "/market?x=1",
    "/news#top",
    "/nope",
    "/settings",
    "/reviewsx",
    "",
  ];
  it.each([...concrete, ...extra])("%s", (p) => {
    expect(activeTabOf(p)).toBe(activeTab(p));
  });
});
