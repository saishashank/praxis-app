// Picks (UXN-040, UXN-041, UXN-045; ch.16 16.21). Decision support only: nothing here places an order.
// Read-only for every role; a masked user (Editor/Viewer without a grant) gets "Stock A" and no prices
// (DAT-124), decided in the loader. At most `picks_max_per_family` picks per family are shown.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadPicks, parsePicksQuery } from "@/lib/ui/loaders/picks";
import { Banner, EmptyState } from "@/components/ui/States";
import { PickCard } from "./PickCard";
import { ProfileSwitch } from "./PickTabs";
import { SuccessStrip } from "./SuccessStrip";
import { maxPerFamily, pickProfilesConfig } from "./data";
import { capPerFamily, NOT_REAL_ORDERS, profileRules, profileSentence } from "./text";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function PicksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/picks");
  const env = await envFor(user);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const query = await parsePicksQuery(env, q);
  if (query === null) notFound();
  const model = await loadPicks(env, query);
  const max = await maxPerFamily(env.main);
  const rule = profileSentence(profileRules(await pickProfilesConfig(env.main), model.profile));
  const picks = capPerFamily(model.picks, max);

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Picks</h1>
        <p className="m-0 text-sm text-text-muted">
          Ideas for three kinds of portfolio, followed on paper. {NOT_REAL_ORDERS}
          {model.d ? ` Published ${model.d}.` : ""}
        </p>
      </header>

      <ProfileSwitch profiles={model.profiles} current={model.profile} base="/picks" rule={rule} />

      {model.success ? <SuccessStrip success={model.success} profile={model.profile} /> : null}

      {model.state === "stale" && model.staleText ? (
        <Banner tone="warning" title="Out of date">
          {model.staleText}
        </Banner>
      ) : null}

      {picks.length === 0 ? (
        <EmptyState title="No picks yet">
          The system has not published any picks for this profile. They appear after a nightly run
          finds enough evidence.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Picks">
          {picks.map((p) => (
            <li key={p.id} className="min-w-0">
              <PickCard
                pick={p}
                masked={model.masked}
                beatsLuck={model.success?.beatsLuck ?? false}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="m-0 text-sm">
        <Link
          href={`/picks/track-record?profile=${encodeURIComponent(model.profile)}`}
          className="text-accent underline"
        >
          Track record
        </Link>
      </p>
    </main>
  );
}
