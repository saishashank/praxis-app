// V2-S9 (D-706): the V2 go-live steps. The data is in order (a step comes after what it needs), every
// step id is in docs/owner-guide/V2_go_live.md, the page guide keeps tick marks on the device only, and
// the V1 sign-off set is untouched (V2 steps are not part of it).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { V2Steps } from "@/app/(app)/ops/go-live/V2Steps";
import {
  GO_LIVE_ITEM_IDS,
  V2_GO_LIVE_STEPS,
  V2_GO_LIVE_STEP_IDS,
  V2_GUIDE_PATH,
  V2_PHASE_LABELS,
} from "@/lib/golive/checklist";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("V2 go-live steps (data)", () => {
  it("has unique ids and every `after` names an earlier step", () => {
    expect(new Set(V2_GO_LIVE_STEP_IDS).size).toBe(V2_GO_LIVE_STEPS.length);
    V2_GO_LIVE_STEPS.forEach((s, i) => {
      for (const a of s.after) {
        const at = V2_GO_LIVE_STEP_IDS.indexOf(a);
        expect(at, `${s.id} after ${a}`).toBeGreaterThanOrEqual(0);
        expect(at, `${s.id} after ${a}`).toBeLessThan(i);
      }
    });
  });

  it("is grouped by phase in order, and the V1 sign-off set does not contain a V2 step", () => {
    const order = Object.keys(V2_PHASE_LABELS);
    const phases = V2_GO_LIVE_STEPS.map((s) => order.indexOf(s.phase));
    expect(phases.every((p) => p >= 0)).toBe(true);
    expect([...phases].sort((a, b) => a - b)).toEqual(phases);
    for (const id of V2_GO_LIVE_STEP_IDS) expect(GO_LIVE_ITEM_IDS).not.toContain(id);
    expect(GO_LIVE_ITEM_IDS).toHaveLength(7);
  });

  it("orders the migrations before the imports and the rollback test before production", () => {
    const at = (id: string): number => V2_GO_LIVE_STEP_IDS.indexOf(id);
    expect(at("v2_staging_migrations")).toBeLessThan(at("v2_cortex_import"));
    expect(at("v2_staging_migrations")).toBeLessThan(at("v2_experts_import"));
    expect(at("v2_experts_review")).toBeLessThan(at("v2_experts_import"));
    expect(at("v2_experts_import")).toBeLessThan(at("v2_confirm_groups"));
    expect(at("v2_rollback")).toBeLessThan(at("v2_production"));
  });

  it("every step id is in the Owner guide, in the same order, and the rollback runbook exists", () => {
    const guide = readFileSync(V2_GUIDE_PATH, "utf8");
    const found = [...guide.matchAll(/\[(v2_[a-z0-9_]+)\]/g)].map((m) => m[1]);
    expect(found).toEqual([...V2_GO_LIVE_STEP_IDS]);
    expect(guide).toContain("docs/runbooks/rollback-v2.md");
    expect(readFileSync("docs/runbooks/rollback-v2.md", "utf8")).toContain("--down-to 14");
  });
});

describe("V2 go-live documents track the code (R3-S1, R3-S2)", () => {
  const newest = (): string =>
    readdirSync("db/migrations/main")
      .filter((f) => /^[0-9]{4}_.*[.]sql$/.test(f))
      .map((f) => f.slice(0, 4))
      .sort()
      .at(-1)!;

  it("the rollback runbook names the newest migration version and the tables it deletes", () => {
    const runbook = readFileSync("docs/runbooks/rollback-v2.md", "utf8");
    const top = newest();
    expect(top).toBe("0025");
    expect(runbook).toContain(`0015 to ${top}`);
    expect(runbook).toContain(`stays at ${top}`);
    expect(runbook).toContain(`sections of ${top} to 0015`);
    expect(runbook).toContain(`from ${top} and back up`);
    for (const t of [
      "announcement_archive",
      "halt_watch",
      "intraday_arm",
      "sector_composite_daily",
      "angle_forward_flag",
      "instrument_listing",
      "instrument_no_revive",
    ]) {
      expect(runbook, t).toContain(t);
    }
    expect(runbook).toContain("SELECT * FROM instrument_listing");
    expect(runbook).toContain("code_reuse_suspected:%");
  });

  it("the guide and the steps cover the production path and both ZAP preconditions", () => {
    const guide = readFileSync(V2_GUIDE_PATH, "utf8");
    for (const needle of [
      "ZAP_IMAGE_PINNED",
      "zap-baseline.yml",
      "staging-e2e-day.yml",
      "rc/<sha>",
      "deploy-production",
      "release gate",
    ]) {
      expect(guide, needle).toContain(needle);
    }
    const text = JSON.stringify(V2_GO_LIVE_STEPS);
    for (const needle of ["ZAP_IMAGE_PINNED", "Staging E2E day", "ZAP baseline", "rc/<sha>"]) {
      expect(text, needle).toContain(needle);
    }
    const at = (id: string): number => V2_GO_LIVE_STEP_IDS.indexOf(id);
    expect(at("v2_zap_pin")).toBeLessThan(at("v2_push_ci"));
    expect(at("v2_merge_main")).toBeLessThan(at("v2_release_evidence"));
    expect(at("v2_release_evidence")).toBeLessThan(at("v2_production"));
    expect(V2_GO_LIVE_STEP_IDS.at(-1)).toBe("v2_production");
  });
});

describe("V2Steps component", () => {
  const props = {
    phases: Object.entries(V2_PHASE_LABELS).map(([id, label]) => ({ id, label })),
    steps: V2_GO_LIVE_STEPS.map((s) => ({ ...s, after: [...s.after] })),
    guidePath: V2_GUIDE_PATH,
  };

  it("shows every step numbered in order and keeps ticks on this device only", () => {
    render(<V2Steps {...props} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(V2_GO_LIVE_STEPS.length);
    expect(screen.getByText(/^1\. Check the repo hygiene list/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(`0 of ${V2_GO_LIVE_STEPS.length}`);
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByRole("status")).toHaveTextContent(`1 of ${V2_GO_LIVE_STEPS.length}`);
    expect(window.localStorage.getItem("praxis.v2golive.done")).toContain("v2_hygiene");
    cleanup();
    render(<V2Steps {...props} />);
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
  });

  it("names prerequisites by step number, and an unknown id by its id", () => {
    const [first, second] = props.steps;
    render(
      <V2Steps
        {...props}
        steps={[
          { ...first!, after: [] },
          { ...second!, after: [first!.id, "v2_not_a_step"] },
        ]}
      />,
    );
    expect(screen.getByText("After step 1, v2_not_a_step.")).toBeInTheDocument();
    expect(screen.getAllByText(/^After step/)).toHaveLength(1);
  });

  it("works when storage is blocked", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      render(<V2Steps {...props} />);
      expect(screen.getAllByRole("checkbox")).toHaveLength(V2_GO_LIVE_STEPS.length);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
