// The expert polling job (M22 E2; KB-082, DAT-228, D-939, D-1429, D-1478). One run a day (one `expert_poll_run` row of kind
// `poll`, so a second run on the same day does nothing): read the tracked experts' sources whose latest licence row is
// `enabled` or `owner-accepted-risk` (never `unchecked`, `no`, manual-only, or a source with no known feed address), in the
// order of `pollOrder`, through `pollFeeds` (robots first, conditional requests, the request cap) behind `guardedFetch` (own
// origin only, no private address, no cross-origin redirect). At most `expert_poll_items_daily` NEW items are stored; each is a
// link, a title, a time and, only where the terms say summaries are fine, one short line of our own (a source whose
// summarising is `unknown` or `no` keeps titles and links only, D-1430). A source whose items did not all fit under the cap
// keeps no validators, so tomorrow's request is not answered "not modified" and the rest is picked up then.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { sourcesOf, LICENCE_AGENT, type LicenceSource } from "@/lib/experts/licence/engine.mjs";
import { isPollable, titleAndLinkOnly } from "@/lib/experts/licence/policy";
import { latestLicence } from "@/lib/experts/licence/store";
import { pollFeeds, newPollState, type PollReport, type RecordedItem } from "@/lib/kb/fetchRules";
import { guardedFetch, originOf, REFUSALS, type RawFetch, type Refusal } from "./guard";
import { pollOrder } from "./priority";
import {
  insertItem,
  ownSummary,
  pollFactsOf,
  recordRun,
  runExists,
  savePollState,
  trackedExperts,
  validatorsOf,
  withValidators,
  type PollExpert,
} from "./store";

export const REQUEST_CAP = 600; // threshold-ok: requests a day, robots files included (about 150 experts, up to four sources)
const MAX_SOURCES_PER_EXPERT = 10; // threshold-ok: the licence source cap (engine LIMITS.maxSourcesPerExpert)
const YOUTUBE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PollDeps = {
  fetch: RawFetch;
  resolve?: (host: string) => Promise<readonly string[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The day the run is for (YYYY-MM-DD); default is the UTC date of `now`. */
  day?: string;
  agent?: string;
  requestCap?: number;
};

export type PollRunReport = {
  skipped: "already_ran" | "off" | null;
  experts: number;
  sources: number;
  requested: number;
  newItems: number;
  seenItems: number;
  notModified: number;
  disallowed: number;
  failed: number;
  capped: number;
  refused: number;
  /** Sources left alone because their licence row does not allow reading. */
  notAllowed: number;
};

const empty = (skipped: PollRunReport["skipped"]): PollRunReport => ({
  skipped,
  experts: 0,
  sources: 0,
  requested: 0,
  newItems: 0,
  seenItems: 0,
  notModified: 0,
  disallowed: 0,
  failed: 0,
  capped: 0,
  refused: 0,
  notAllowed: 0,
});

/** The address the feed of one source is read from: its own origin, nothing else. Null when there is none. */
export function feedUrlOf(s: LicenceSource): string | null {
  if (s.manual || s.origin === null) return null;
  if (s.kind === "platform") {
    const handle = s.key.slice(s.key.indexOf(":") + 1);
    if (!YOUTUBE_ID.test(handle)) return null;
    return `${s.origin}${s.path}?channel_id=${encodeURIComponent(handle)}`;
  }
  const url = `${s.origin}${s.path}`;
  return originOf(url) === s.origin ? url : null;
}

type Planned = {
  id: string;
  expert: PollExpert;
  source: LicenceSource;
  url: string;
  summaries: boolean;
};

export async function runPoll(db: Client, deps: PollDeps): Promise<PollRunReport> {
  const now = deps.now ?? (() => new Date());
  const day = deps.day ?? now().toISOString().slice(0, 10);
  if (await runExists(db, "poll", day)) return empty("already_ran");
  const itemCap = Number(await getConfig(db, "expert_poll_items_daily"));
  const rep = empty(null);
  if (!Number.isFinite(itemCap) || itemCap <= 0) {
    await recordRun(db, "poll", day, { off: 1 }, now().toISOString());
    return { ...rep, skipped: "off" };
  }
  const experts = await trackedExperts(db);
  const facts = await pollFactsOf(db, experts);
  const order = pollOrder(facts, day, Number(await getConfig(db, "expert_min_scored")));
  const byId = new Map(experts.map((e) => [e.id, e]));

  const plan: Planned[] = [];
  for (const id of order) {
    const e = byId.get(id)!;
    if (e.noFeed) continue;
    for (const source of sourcesOf(e).slice(0, MAX_SOURCES_PER_EXPERT)) {
      const url = feedUrlOf(source);
      if (url === null) continue; // manual-only or no known feed address: not read, not counted
      const lic = await latestLicence(db, { expertId: e.id, sourceKey: source.key });
      if (!isPollable(lic?.status)) {
        rep.notAllowed += 1;
        continue;
      }
      plan.push({
        id: `s${plan.length}`,
        expert: e,
        source,
        url,
        summaries: lic !== null && !titleAndLinkOnly(lic.summarisation),
      });
    }
  }
  rep.experts = new Set(plan.map((p) => p.expert.id)).size;
  rep.sources = plan.length;

  const refusals: Record<Refusal, number> = Object.fromEntries(
    REFUSALS.map((r) => [r, 0]),
  ) as Record<Refusal, number>;
  const state = newPollState();
  for (const p of plan) {
    const v = validatorsOf(p.expert.poll, p.source.key);
    if (v !== undefined) state.validators.set(p.url, v);
  }
  const fetched = new Map<string, RecordedItem[]>();
  const recorded: RecordedItem[] = [];
  let report: PollReport = {
    requested: 0,
    recorded: 0,
    notModified: 0,
    disallowed: [],
    capped: [],
    failed: [],
  };
  if (plan.length > 0) {
    report = await pollFeeds({
      sources: plan.map((p) => ({ id: p.id, url: p.url })),
      fetch: guardedFetch({
        fetch: deps.fetch,
        origins: new Set(plan.map((p) => p.source.origin!)),
        resolve: deps.resolve,
        sleep: deps.sleep,
        onRefused: (r) => {
          refusals[r] += 1;
        },
      }),
      state,
      day,
      dailyCap: deps.requestCap ?? REQUEST_CAP,
      agent: deps.agent ?? LICENCE_AGENT,
      record: (it) => {
        recorded.push(it);
        const list = fetched.get(it.source) ?? [];
        list.push(it);
        fetched.set(it.source, list);
      },
    });
  }
  rep.requested = report.requested;
  rep.notModified = report.notModified;
  rep.disallowed = report.disallowed.length;
  rep.failed = report.failed.length;
  rep.capped = report.capped.length;
  rep.refused = Object.values(refusals).reduce((a, b) => a + b, 0);

  // Store in plan order, new items only count against the cap.
  const at = now().getTime();
  let tick = 0;
  const complete = new Set<string>();
  for (const p of plan) {
    const items = fetched.get(p.id);
    if (items === undefined) continue;
    let all = true;
    for (const it of items) {
      if (rep.newItems >= itemCap) {
        all = false;
        break;
      }
      const isNew = await insertItem(db, {
        expertId: p.expert.id,
        url: it.url,
        platform: p.source.kind === "platform" ? p.source.key.split(":")[0]! : "site",
        title: it.title,
        publishedAt: it.publishedAt,
        summary: p.summaries ? ownSummary(it.title, it.url) : null,
        ingestedAt: new Date(at + tick++).toISOString(), // distinct and increasing: the extraction watermark orders by it
      });
      if (isNew) rep.newItems += 1;
      else rep.seenItems += 1;
    }
    if (all) complete.add(p.id);
  }

  // State back to each polled expert: validators of the sources that were read in full, the poll time.
  const stamp = now().toISOString();
  const touched = new Set<string>();
  for (const p of plan) {
    const failed = report.failed.includes(p.id) || report.capped.includes(p.id);
    if (failed || report.disallowed.includes(p.id)) continue;
    const e = p.expert;
    let next = touched.has(e.id) ? e.poll : { ...e.poll };
    next = withValidators(
      next,
      p.source.key,
      complete.has(p.id) || !fetched.has(p.id) ? state.validators.get(p.url) : undefined,
    );
    next = { ...next, p: stamp };
    e.poll = next;
    touched.add(e.id);
  }
  for (const id of touched) await savePollState(db, id, byId.get(id)!.poll, stamp);

  await recordRun(
    db,
    "poll",
    day,
    {
      experts: rep.experts,
      sources: rep.sources,
      requested: rep.requested,
      new: rep.newItems,
      seen: rep.seenItems,
      notModified: rep.notModified,
      disallowed: rep.disallowed,
      failed: rep.failed,
      capped: rep.capped,
      refused: rep.refused,
      notAllowed: rep.notAllowed,
    },
    stamp,
  );
  return rep;
}
