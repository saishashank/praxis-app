// A Market query for loader tests (D-205): Top movers open, All sizes, first pages, unless overridden.
import type { MarketQuery } from "@/lib/ui/loaders/market";

export const mq = (over: Partial<MarketQuery> = {}): MarketQuery => ({
  open: ["movers"],
  size: "all",
  page: 1,
  upPage: 1,
  downPage: 1,
  tradedPage: 1,
  ...over,
});
