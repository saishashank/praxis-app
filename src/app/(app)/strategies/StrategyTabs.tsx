// Tabs of the Strategies area (UXR-023, UXR-002): Overview, Leaderboard, Ideas, Risk, What-if. The routes
// are kept; the current tab shows a filled surface, a check mark and aria-current plus a hidden "Selected".
import { Segmented } from "@/components/ui/Segmented";

export type StrategyTab = "overview" | "leaderboard" | "ideas" | "risk" | "whatif";

const ITEMS = [
  { value: "overview", label: "Overview", href: "/strategies" },
  { value: "leaderboard", label: "Leaderboard", href: "/strategies/leaderboard" },
  { value: "ideas", label: "Ideas", href: "/strategies/ideas" },
  { value: "risk", label: "Risk", href: "/strategies/risk" },
  { value: "whatif", label: "What-if", href: "/what-if" },
];

export function StrategyTabs({ current }: { current: StrategyTab }) {
  return <Segmented label="Strategy pages" items={ITEMS} value={current} />;
}
