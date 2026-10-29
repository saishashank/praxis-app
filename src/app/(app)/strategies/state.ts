// Strategy state for the pill (UXR-045): Running, Paused, Target reached, Stopped. Derived from the
// loader's stage and control state; a strategy with no round yet has no state.
import type { StrategyTile } from "@/lib/ui/loaders/strategies";

export type TileState = "running" | "paused" | "target" | "stopped";

export function tileState(
  t: Pick<StrategyTile, "hasCohort" | "stage" | "control">,
): TileState | null {
  if (!t.hasCohort) return null;
  if (t.control === "killed" || t.stage === "bust" || t.stage === "stall") return "stopped";
  if (t.stage === "target") return "target";
  if (t.control === "paused") return "paused";
  return "running";
}
