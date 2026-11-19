// @vitest-environment node
// M21 C3 (EML-043, D-1226): the stop-hit template. It is the `pick_cleared` kind with variant `stop_hit`;
// its key matches the existing kind pattern; the subject and body words are fixed; the D-922 scan finds no
// internal code; and the existing cleared variants render exactly as before (the AU output is unchanged).
import { describe, expect, it } from "vitest";
import { emailKeys, keyMatchesKind } from "@/lib/email/keys";
import { renderPickCleared } from "@/lib/email/templates";
import * as fx from "../fixtures/email/facts";

const base = { env: "production" as const, appUrl: fx.APP };
const STOP_HIT = {
  alertId: "d".repeat(64),
  code: "ZZ04",
  name: "Zed Four Limited",
  variant: "stop_hit" as const,
  limit: "A$5.000",
  stop: "A$4.600",
  last: "A$4.500",
  quoteTime: "Wed 4 Nov 2026 11:05 AEDT",
};

describe("stop-hit mail (EML-043)", () => {
  const out = renderPickCleared({ ...base, facts: STOP_HIT });

  it("subject and words", () => {
    expect(out.subject).toBe("[Praxis] ZZ04 traded under its stop (delayed)");
    expect(out.text.toLowerCase()).toContain("traded under its stop (delayed)");
    expect(out.text).toContain("information only");
    expect(out.text).toContain("You manage your own stop with your broker");
    expect(out.text).toContain("A$4.500 at Wed 4 Nov 2026 11:05 AEDT (delayed)");
    expect(out.text).toContain("up to about 20 + 5 minutes after the trade");
    expect(out.oversize).toBe(false);
  });

  it("D-922: no internal codes, no real-time claim, links stay on the app host", () => {
    for (const s of [out.text.replace(/https?:\/\/\S+/g, ""), out.html.replace(/<[^>]*>/g, " ")]) {
      expect(s).not.toMatch(/\bE\d{2}\b/);
      expect(s).not.toMatch(/\bF\d-[UL]\b/);
      expect(s).not.toMatch(/\bARN-\d+/);
      expect(s).not.toMatch(/\bP[012]\b/);
      expect(s).not.toMatch(/real[- ]?time/i);
    }
    for (const m of out.html.matchAll(/href="([^"]+)"/g))
      expect(m[1].startsWith(fx.APP)).toBe(true);
  });

  it("the key matches the pick_cleared pattern and differs from the cleared mail's key", () => {
    const k = emailKeys.pickStopHit(STOP_HIT.alertId, "2026-11-04");
    expect(keyMatchesKind("pick_cleared", k)).toBe(true);
    expect(k).not.toBe(emailKeys.pickCleared(STOP_HIT.alertId, "2026-11-04"));
  });

  it("staging subject is prefixed like every pick mail", () => {
    const o = renderPickCleared({ env: "staging", appUrl: fx.APP, facts: STOP_HIT });
    expect(o.subject.startsWith("[STAGING] [Praxis]")).toBe(true);
  });

  it("the existing cleared variants are unchanged (default-off output identical)", () => {
    const below = renderPickCleared({ ...base, facts: fx.PICK_CLEARED_BELOW });
    expect(below.subject).toBe("[Praxis] Pick cleared — ZZ02 fell under its stop (delayed)");
    expect(below.text).toContain("Idea invalid before entry: price fell under the stop.");
    expect(below.text).toContain("No action is needed; Praxis has stopped watching this pick");
    expect(below.text).not.toContain("Praxis places no order");
    const cap = renderPickCleared({ ...base, facts: fx.PICK_CLEARED_CAP });
    expect(cap.subject).toMatch(/ran above its limit \(delayed\)$/);
  });
});
