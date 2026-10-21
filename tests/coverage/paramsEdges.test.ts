// @vitest-environment node
// M8 T3 coverage (TST-121): the agent parameter resolver and the rule-version overlay: a getter that
// throws or returns an invalid value falls back to the registry default, portfolio amounts are
// ordered by name, and each optional key of a rule version replaces only its own slice.
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "@/lib/config/keys";
import {
  agentParamKeys,
  agentParamsSha,
  defaultAgentParams,
  paramsWithVersion,
  resolveAgentParams,
} from "@/lib/agents/params";

const base = defaultAgentParams();

describe("resolveAgentParams", () => {
  it("equals the defaults when every read is missing, throws, or returns an invalid value", async () => {
    const keys = agentParamKeys();
    const bad = keys[0]!;
    const throwing = keys[1]!;
    const p = await resolveAgentParams((k) => {
      if (k === throwing) throw new Error("store unavailable");
      if (k === bad) return { not: "valid" };
      return undefined;
    });
    expect(agentParamsSha(p)).toBe(agentParamsSha(base));
  });

  it("an async getter is awaited and a valid stored value wins", async () => {
    const key = "profile_portfolio_amount" as const;
    const stored = { conservative: 1000, balanced: 2000, aggressive: 3000 };
    const p = await resolveAgentParams(async (k) => (k === key ? stored : undefined));
    const names = Object.keys(p.picks.portfolioAmounts);
    expect(names).toEqual([...names].sort());
    expect(p.picks.portfolioAmounts).toEqual({ aggressive: 3000, balanced: 2000, conservative: 1000 });
  });
});

describe("paramsWithVersion", () => {
  it("replaces only the family slice when the version holds no optional keys", () => {
    const out = paramsWithVersion(base, "F1", {});
    expect(out.f2).toBe(base.f2);
    expect(out.reentryBlock).toBe(base.reentryBlock);
    expect(out.insiderWeights).toBe(base.insiderWeights);
  });

  it("re-entry block and the event polarity threshold come from the version when it carries them", () => {
    const out = paramsWithVersion(base, "F2", {
      reentry_block: CONFIG_KEYS.reentry_block.default,
      event_polarity_threshold_pct: CONFIG_KEYS.event_polarity_threshold_pct.default,
    });
    expect(out.reentryBlock).toEqual(base.reentryBlock);
    expect(out.eventPolarityThreshold).toEqual(base.eventPolarityThreshold);
  });

  it("F6 takes the insider weights and window only when the version carries them", () => {
    const only = paramsWithVersion(base, "F6", {
      insider_score_weights: CONFIG_KEYS.insider_score_weights.default,
    });
    expect(only.insiderWeights).toEqual(base.insiderWeights);
    expect(only.insiderWindowSessions).toBe(base.insiderWindowSessions);
    const win = paramsWithVersion(base, "F6", {
      insider_window_sessions: CONFIG_KEYS.insider_window_sessions.default,
    });
    expect(win.insiderWindowSessions).toBe(base.insiderWindowSessions);
    const other = paramsWithVersion(base, "F3", {
      insider_score_weights: CONFIG_KEYS.insider_score_weights.default,
    });
    expect(other.insiderWeights).toBe(base.insiderWeights);
  });
});
