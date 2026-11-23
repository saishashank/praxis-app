// Picks (UXN-040, UXN-041, UXN-045; ch.16 16.21). Decision support only: nothing here places an order.
// Read-only for every role; a masked user (Editor/Viewer without a grant) gets "Stock A" and no prices
// (DAT-124), decided in the loader. At most `picks_max_per_family` picks per family are shown.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { ownerToolsVisibleTo } from "@/lib/auth/ownerToolsGuard";
import { envFor } from "@/lib/ui/loaders/shell";
import {
  ALL_PROFILES,
  historyFilterOf,
  loadPicks,
  parsePicksQuery,
  sortPicks,
  type HistoryFilter,
} from "@/lib/ui/loaders/picks";
import { Banner } from "@/components/ui/States";
import { PickTable } from "./PickTable";
import { ProfileSwitch } from "./PickTabs";
import { ViewSelect } from "./ViewSelect";
import { pickViewHref, pickViewOf } from "./views";
import { PicksEmptyArt } from "./EmptyArt";
import { TrackRecordBody } from "./TrackRecordBody";
import { HistoryBody } from "./HistoryBody";
import { SuccessStrip } from "./SuccessStrip";
import { IntradaySection } from "./IntradaySection";
import { SortToggle } from "./SortToggle";
import { setPicksSortAction } from "../settings/alerts/actions";
import { loadAlertChips, loadIntraday, loadPicksSort } from "@/lib/ui/loaders/pickAlerts";
import { maxPerFamily, pickProfilesConfig } from "./data";
import {
  capPerFamily,
  EMPTY_PICKS_SENTENCE,
  HISTORY_PURPOSE,
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
  const env = await envFor(user, undefined, sp.market);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const view = pickViewOf(sp.view);
  // D-1858: the History tab also lists every profile together (`profile=all`)
  const allProfiles = view === "history" && sp.profile === ALL_PROFILES;
  // the other views have no all-profiles list: they open on the default profile
  if (!allProfiles && sp.profile === ALL_PROFILES) q.delete("profile");
  const query = allProfiles
    ? { profile: ALL_PROFILES, d: undefined }
    : await parsePicksQuery(env, q);
  if (query === null) notFound();
  if (view === "track") return await TrackView({ env, profile: query.profile });
  if (view === "history")
    return await HistoryView({
      env,
      profile: query.profile,
      filter: historyFilterOf(sp.status),
      cursor: typeof sp.after === "string" ? sp.after : null,
    });
  const model = await loadPicks(env, query);
  const max = await maxPerFamily(env.main);
  const rule = profileSentence(
    profileRules(await pickProfilesConfig(env.main), model.profile),
    model.profile,
  );
  const sort = await loadPicksSort(env);
  const picks = sortPicks(capPerFamily(model.picks, max), sort);
  const chips = model.realD ? await loadAlertChips(env, model.realD) : new Map();
  const intraday = await loadIntraday(env);
  // M21 D-1214, D-1219: the Owner's tier label and broker links ride on the tile through its `extra` slot, computed only
  // when the one hidden-route predicate says the tools are visible to this user; the module is loaded then and only then.
  const extras = (await ownerToolsVisibleTo(user))
    ? await (
        await import("@/lib/ownerTools/pickExtras")
      ).pickExtras({
        user,
        market: env.market,
        profile: model.profile,
        picks: picks.map((p) => ({ id: p.id, code: p.stock })),
      })
    : null;

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Picks</h1>
        <p className="m-0 text-sm text-text-muted">
          Ideas for three kinds of portfolio, followed on paper. {NOT_REAL_ORDERS}
          {model.d ? ` Published ${model.d}.` : ""}
        </p>
      </header>

      <ProfileSwitch
        profiles={model.profiles}
        current={model.profile}
        hrefFor={(p) => pickViewHref("today", p)}
        rule={rule}
        viewSelect={<ViewSelect current="today" profile={model.profile} />}
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
        <PickTable
          picks={picks}
          profile={model.profile}
          masked={model.masked}
          beatsLuck={model.success?.beatsLuck ?? false}
          chips={chips}
          realD={model.realD}
          extras={extras}
          labelledBy="tonight-h"
        />
      )}

      <IntradaySection model={intraday} />
    </main>
  );
}

async function HistoryView({
  env,
  profile,
  filter,
  cursor,
}: {
  env: Awaited<ReturnType<typeof envFor>>;
  profile: string;
  filter: HistoryFilter;
  cursor: string | null;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Picks</h1>
        <p className="m-0 text-sm text-text-muted">
          {HISTORY_PURPOSE} {NOT_REAL_ORDERS}
        </p>
      </header>
      {await HistoryBody({
        env,
        profile,
        filter,
        cursor,
        viewSelect: <ViewSelect current="history" profile={profile} />,
      })}
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
          Nothing shown here can be changed afterwards. {NOT_REAL_ORDERS}
        </p>
      </header>
      {await TrackRecordBody({
        env,
        profile,
        hrefFor: (p) => pickViewHref("track", p),
        viewSelect: <ViewSelect current="track" profile={profile} />,
      })}
    </main>
  );
}
