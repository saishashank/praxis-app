// Portfolio (D-1849, moved off the Picks page, Owner 2026-11-19): the three practice portfolios of "My
// portfolio" (D-950), one per risk profile. Picks is the same for everyone; this page is the user's own
// view, so it has its own tab. Read-only for every role; a masked user (Editor/Viewer without a grant)
// gets the letter of each stock and percentages only, decided in the loader (DAT-124). Freshness is in
// trading terms ("End of day, Fri 13 Nov", "Delayed, 13:20"), never an internal run time.
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadMyPortfolios } from "@/lib/ui/loaders/pickPortfolio";
import { NOT_REAL_ORDERS } from "../picks/text";
import { PortfolioCard } from "./PortfolioCard";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/portfolio");
  const env = await envFor(user, undefined, sp.market);
  const portfolio = await loadMyPortfolios(env);
  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <PortfolioCard v={portfolio} headingLevel={1} />
      <p className="m-0 text-xs text-text-muted">{NOT_REAL_ORDERS}</p>
    </main>
  );
}
