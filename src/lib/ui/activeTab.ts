// The tab a pathname belongs to, for the client TabBar (aria-current). Same answer as `activeTab` in
// nav.ts (tests/shell/activeTab.test.ts checks every route of the model), but without the route table
// and its labels, so the TabBar does not carry them in the first-load JS (UX-005 budget).
import type { TabId } from "./nav";

const ROOTS: ReadonlyArray<readonly [string, TabId]> = [
  ["/picks", "picks"],
  ["/market", "market"],
  ["/strategies", "strategies"],
  ["/news", "news"],
  ["/reviews", "reviews"],
];

/** Pages of a tab whose path does not start with the tab's own (alerts, what-if, cortex, cards). */
const EXACT: Readonly<Record<string, TabId>> = {
  "/alerts": "picks",
  "/what-if": "strategies",
  "/cortex": "strategies",
};

export function activeTabOf(pathname: string): TabId | null {
  const segs = pathname.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const p = "/" + segs.join("/");
  if (p === "/") return "home";
  if (EXACT[p]) return EXACT[p]!;
  if (segs[0] === "cards" && segs.length === 2) return "strategies";
  for (const [root, id] of ROOTS) if (p === root || p.startsWith(root + "/")) return id;
  return null;
}
