// Picks (UXN-040, UXN-041, UXN-045; ch.16 16.21). Decision support only: nothing here places an order.
// Read-only for every role; a masked user (Editor/Viewer without a grant) gets "Stock A" and no prices
// (DAT-124), decided in the loader. At most `picks_max_per_family` picks per family are shown.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadPicks, parsePicksQuery, sortPicks } from "@/lib/ui/loaders/picks";
import { Banner } from "@/components/ui/States";
import { PickCard } from "./PickCard";
import { ProfileSwitch, ViewTabs } from "./PickTabs";
import { PicksEmptyArt } from "./EmptyArt";
import { TrackRecordBody } from "./TrackRecordBody";
import { SuccessStrip } from "./SuccessStrip";
import { IntradaySection } from "./IntradaySection";
import { SortToggle } from "./SortToggle";
import { setPicksSortAction } from "../settings/alerts/actions";
import { loadAlertChips, loadIntraday, loadPicksSort } from "@/lib/ui/loaders/pickAlerts";
import { maxPerFamily, pickProfilesConfig } from "./data";
import {
  capPerFamily,
  EMPTY_PICKS_SENTENCE,
  SORT_WORDS,
  TONIGHT_TITLE,
  NOT_REAL_ORDERS,
  profileRules,
  profileSentence,
} from "./text";

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
  const track = sp.view === "track";
  if (track) return await TrackView({ env, profile: query.profile });
  const model = await loadPicks(env, query);
  const max = await maxPerFamily(env.main);
  const rule = profileSentence(profileRules(await pickProfilesConfig(env.main), model.profile));
  const sort = await loadPicksSort(env);
  const picks = sortPicks(capPerFamily(model.picks, max), sort);
  const chips = model.realD ? await loadAlertChips(env, model.realD) : new Map();
  const intraday = await loadIntraday(env);

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Picks</h1>
        <p className="m-0 text-sm text-text-muted">
          Ideas for three kinds of portfolio, followed on paper. {NOT_REAL_ORDERS}
          {model.d ? ` Published ${model.d}.` : ""}
        </p>
      </header>

      <ViewTabs current="today" profile={model.profile} />

      <ProfileSwitch
        profiles={model.profiles}
        current={model.profile}
        hrefFor={(p) => `/picks?profile=${encodeURIComponent(p)}`}
        rule={rule}
      />

      {model.success ? <SuccessStrip success={model.success} profile={model.profile} /> : null}

      {model.state === "stale" && model.staleText ? (
        <Banner tone="warning" title="Out of date">
          {model.staleText}
        </Banner>
      ) : null}

      <h2 className="m-0 text-lg font-semibold" id="tonight-h">
        {TONIGHT_TITLE}
      </h2>
      {picks.length > 0 ? (
        <SortToggle
          action={setPicksSortAction}
          current={sort}
          words={{
            basis: sort === "chance" ? SORT_WORDS.chance : SORT_WORDS.expected_gain,
            toggle: sort === "chance" ? SORT_WORDS.toGain : SORT_WORDS.toChance,
          }}
        />
      ) : null}
      {picks.length === 0 ? (
        <PicksEmptyArt title="No picks yet">{EMPTY_PICKS_SENTENCE}</PicksEmptyArt>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-labelledby="tonight-h">
          {picks.map((p) => (
            <li key={p.id} className="min-w-0">
              <PickCard
                pick={p}
                masked={model.masked}
                beatsLuck={model.success?.beatsLuck ?? false}
                chip={chips.get(`${model.realD}.${model.profile}.${p.rank}`) ?? null}
              />
            </li>
          ))}
        </ul>
      )}

      <IntradaySection model={intraday} />
    </main>
  );
}

async function TrackView({
  env,
  profile,
}: {
  env: Awaited<ReturnType<typeof envFor>>;
  profile: string;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Picks</h1>
        <p className="m-0 text-sm text-text-muted">
          Every pick as published, next to what happened. Price only — dividends not included.
          Nothing shown here can be changed afterwards. {NOT_REAL_ORDERS}
        </p>
      </header>
      <ViewTabs current="track" profile={profile} />
      {await TrackRecordBody({
        env,
        profile,
        hrefFor: (p) => `/picks?profile=${encodeURIComponent(p)}&view=track`,
      })}
    </main>
  );
}
