// The licence check run (M22 E1; KB-083, D-1429, D-1430). `runLicenceCheck` reads every fetchable source of the
// tracked experts once (the loop is `checkExperts` in engine.mjs, shared with the build-machine script), appends one
// `expert_source_licence` row per source (actor `job`) and returns counts. The monthly mode (`runMonthlyLicence`) is
// the entry the experts job calls on the first run of each month; it records one `expert_poll_run` row of kind
// `licence`. Network access is the injected `fetch` (tests pass fixtures; the job passes the platform fetch):
// robots.txt is read first and obeyed, nothing is fetched from a manual-only platform (D-522), the whole run has a
// request cap, and a shared origin is read once.
import type { Client } from "@libsql/client";
import { checkExperts, type LicenceReport, type SourceFetch } from "./engine.mjs";
import {
  appendLicence,
  latestLicenceOf,
  licenceExperts,
  licenceRunInMonth,
  recordLicenceRun,
  type LicenceExpert,
  type LicenceRow,
} from "./store";

export type { LicenceReport };

export type LicenceRunDeps = {
  fetch: SourceFetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  agent?: string;
  maxRequests?: number;
  /** Experts to check instead of the tracked and candidate ones (tests). */
  experts?: LicenceExpert[];
};

/** Reads each fetchable source once and appends its row. Never throws for a network failure. */
export async function runLicenceCheck(
  db: Pick<Client, "execute">,
  deps: LicenceRunDeps,
): Promise<LicenceReport> {
  const experts = deps.experts ?? (await licenceExperts(db));
  const latest = new Map<string, Map<string, LicenceRow>>();
  for (const e of experts) if (!e.noFeed) latest.set(e.id, await latestLicenceOf(db, e.id));
  const { rows, report } = await checkExperts({
    experts,
    previous: (id, key) => latest.get(id)?.get(key)?.status ?? null,
    fetch: deps.fetch,
    sleep: deps.sleep,
    agent: deps.agent,
    now: deps.now,
    maxRequests: deps.maxRequests,
  });
  for (const r of rows) await appendLicence(db, { ...r, actor: "job" });
  return report;
}

/**
 * The monthly mode of the experts job (D-1429): runs once per calendar month, on the first call of the month, and
 * records the counts. Returns null when this month already has its run.
 */
export async function runMonthlyLicence(
  db: Pick<Client, "execute">,
  deps: LicenceRunDeps & { day?: string },
): Promise<LicenceReport | null> {
  const now = deps.now ?? (() => new Date());
  const day = deps.day ?? now().toISOString().slice(0, 10);
  if (await licenceRunInMonth(db, day)) return null;
  const rep = await runLicenceCheck(db, deps);
  await recordLicenceRun(db, day, { ...rep }, now().toISOString());
  return rep;
}
