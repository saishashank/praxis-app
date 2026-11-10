// Tabs of the Strategies area (UXR-023, UXR-002): Overview and Risk stay in front; the research pages sit
// in a second, smaller row under a "Research:" label so a beginner is not faced with seven tabs. The
// routes are kept; the current tab shows a filled surface, a check mark and aria-current plus a hidden
// "Selected". Plain links, so it works without JavaScript.
import { Segmented } from "@/components/ui/Segmented";

export type StrategyTab =
  "overview" | "leaderboard" | "ideas" | "movers" | "risk" | "whatif" | "cortex";

const MAIN = [
  { value: "overview", label: "Overview", href: "/strategies" },
  { value: "risk", label: "Risk", href: "/strategies/risk" },
];

const RESEARCH = [
  { value: "leaderboard", label: "Leaderboard", href: "/strategies/leaderboard" },
  { value: "ideas", label: "All signals", href: "/strategies/ideas" },
  { value: "movers", label: "Movers check", href: "/strategies/movers" }, // D-886
  { value: "whatif", label: "What-if", href: "/what-if" },
  { value: "cortex", label: "Cortex", href: "/cortex" },
];

export function StrategyTabs({ current }: { current: StrategyTab }) {
  return (
    <div className="flex flex-col gap-2">
      <Segmented label="Strategy pages" items={MAIN} value={current} />
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <span className="text-sm text-text-muted">Research:</span>
        <Segmented label="Research pages" items={RESEARCH} value={current} />
      </div>
    </div>
  );
}
