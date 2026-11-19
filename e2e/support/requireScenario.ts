// TST-134 / D-966 (M18): a spec states the lane it needs and FAILS, never skips, when it is run in the
// wrong one. The `e2e` job of ci.yml lists every spec file in exactly one lane step (scenario `empty`,
// `populated`, `rich` or the `walks` capture), and scripts/ci/e2e-listing.test.mjs checks that listing, so
// a mis-listed spec is red instead of silently passing as "skipped".
//
// requireScenario("rich")   the run's E2E_SCENARIO (default "empty") must be "rich"
// requireEnv("E2E_WALK", h) the variable must be set; `h` says how to run the lane
// Both throw while the spec file loads, so the run fails and names the lane.

export type Scenario = "empty" | "populated" | "rich";

export function requireScenario(expected: Scenario, how = "run it in its CI lane"): void {
  const actual = process.env.E2E_SCENARIO || "empty";
  if (actual !== expected) {
    throw new Error(
      `this spec needs E2E_SCENARIO=${expected} but the run has ${actual}; ${how} (TST-134)`,
    );
  }
}

export function requireEnv(name: string, how: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`this spec needs ${name} to be set; ${how} (TST-134)`);
  return v;
}
