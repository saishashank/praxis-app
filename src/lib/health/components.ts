// The nine health components (UXN-283, PLT-061; M5 T13, design 4.7, decision 28). A pure function
// of already-read facts: no clock, no database, no network. The reminder, Evening Review sections 1
// and 9 and System Health all read the result, so they cannot disagree.
//
// State words follow the snapshot contract in attention.ts (D-097): healthy | attention | down
// (amber and red). Each unhealthy component lists items with a stable key (the snooze unit), a
// label, a one-line fix and the Control Room anchor. `since_d` is added by the snapshot writer from
// the previous snapshot, never here.
import { HEALTH_COMPONENTS, type HealthComponent } from "@/lib/sentinel/schema";

export type ComponentState = "healthy" | "attention" | "down";
export type ItemState = "attention" | "down";
export type LevelFact = "ok" | "notice" | "alert" | "degrade" | "no data";
export type JobFact = "ok" | "stale" | "failed" | "no data";

export interface HealthItem {
  key: string;
  label: string;
  state: ItemState;
  deadline_d: string | null;
  fix: string;
  fix_path: string;
}

export interface ComponentResult {
  id: HealthComponent;
  state: ComponentState;
  reason: string;
  items: HealthItem[];
}

export interface CredentialFact {
  name: string;
  label: string;
  expiresOn: string;
}

export interface HealthFacts {
  /** Melbourne local date, YYYY-MM-DD. */
  today: string;
  nowMs: number;
  /** MKT-106 `active`: the arena runs (market mode full). */
  marketActive: boolean;
  /** Latest successful Sentinel poll (ISO), null = none yet. */
  sentinelLastOkAt: string | null;
  jobs: Partial<Record<string, JobFact>>;
  /** Data quality: gate failures and open blocking flags for the latest date; null = unreadable. */
  quality: { gateFails: number; blockingFlags: number } | null;
  llmLevel: LevelFact;
  emailMode: "off" | "incidents" | "full";
  /** Newest Evening Review email row: its local date and status; null = none. */
  lastReview: { d: string; status: string } | null;
  dbReadable: boolean;
  storageLevel: LevelFact;
  watchdog: "ok" | "awaiting_first_approval" | "mismatch" | "unknown" | "no data";
  failedSecrets: string[];
  credentials: CredentialFact[];
  /** Worst usage meter over all quotas. */
  quotaLevel: LevelFact;
}

/** Sentinel silence beyond this is amber; beyond the red bound it is red (design 4.2 cadence). */
export const SENTINEL_AMBER_H = 36;
export const SENTINEL_RED_H = 96;
/** A credential this close to its expiry is amber; expired is red (token_warning_days start). */
export const CREDENTIAL_WARN_DAYS = 14;

const DAY_MS = 86_400_000;
const dayNo = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
export const daysUntil = (today: string, d: string): number => dayNo(d) - dayNo(today);

const ANCHOR = (c: HealthComponent): string => `/health#${c.replace(/_/g, "-")}`;

const item = (
  c: HealthComponent,
  key: string,
  label: string,
  state: ItemState,
  fix: string,
  deadline: string | null = null,
): HealthItem => ({ key, label, state, deadline_d: deadline, fix, fix_path: ANCHOR(c) });

function result(id: HealthComponent, items: HealthItem[], okReason: string): ComponentResult {
  const state: ComponentState = items.some((i) => i.state === "down")
    ? "down"
    : items.length
      ? "attention"
      : "healthy";
  return {
    id,
    state,
    reason: items.length ? items.map((i) => i.label).join("; ") : okReason,
    items,
  };
}

function jobItem(
  c: HealthComponent,
  job: string,
  label: string,
  s: JobFact | undefined,
  fix: string,
): HealthItem | null {
  if (s === undefined || s === "ok" || s === "no data") return null; // not run yet is not a fault
  if (s === "failed") return item(c, `job.${job}.failed`, `${label}: last run failed`, "down", fix);
  return item(c, `job.${job}.stale`, `${label}: overdue`, "attention", fix);
}

const compact = (xs: (HealthItem | null)[]): HealthItem[] => xs.filter((x): x is HealthItem => !!x);

function sentinel(f: HealthFacts): ComponentResult {
  const c = "sentinel";
  if (!f.marketActive) return result(c, [], "Off while the market is data-only");
  if (f.sentinelLastOkAt === null) {
    return result(
      c,
      [
        item(
          c,
          "poll.none",
          "Sentinel has not polled yet",
          "attention",
          "Check the Worker Sentinel slot",
        ),
      ],
      "",
    );
  }
  const ageH = (f.nowMs - Date.parse(f.sentinelLastOkAt)) / 3_600_000;
  if (ageH > SENTINEL_RED_H) {
    return result(
      c,
      [
        item(
          c,
          "poll.silent",
          "Sentinel has been silent for days",
          "down",
          "Check the Worker and the ASX feed",
        ),
      ],
      "",
    );
  }
  if (ageH > SENTINEL_AMBER_H) {
    return result(
      c,
      [
        item(
          c,
          "poll.late",
          "Sentinel poll is late",
          "attention",
          "Check the Worker Sentinel slot",
        ),
      ],
      "",
    );
  }
  return result(c, [], "Polling on time");
}

function marketData(f: HealthFacts): ComponentResult {
  const c = "market_data";
  const items = compact([
    jobItem(
      c,
      "ingest-batch1",
      "End-of-day ingest",
      f.jobs["ingest-batch1"],
      "Open Data controls and re-run the ingest",
    ),
    jobItem(
      c,
      "universe-import",
      "Universe import",
      f.jobs["universe-import"],
      "Check the listed-companies source",
    ),
  ]);
  if (f.quality === null) {
    items.push(
      item(c, "quality.unreadable", "Data quality unreadable", "attention", "Open Data quality"),
    );
  } else {
    if (f.quality.gateFails > 0) {
      items.push(
        item(
          c,
          "quality.gate",
          `Quality gate failed on ${f.quality.gateFails} tier(s)`,
          "attention",
          "Open Data quality",
        ),
      );
    }
    if (f.quality.blockingFlags > 0) {
      items.push(
        item(
          c,
          "quality.flags",
          `${f.quality.blockingFlags} blocking data flag(s)`,
          "attention",
          "Open Data quality",
        ),
      );
    }
  }
  return result(c, items, "Data fresh and checks pass");
}

function nightlyRun(f: HealthFacts): ComponentResult {
  const c = "nightly_run";
  if (!f.marketActive) return result(c, [], "Arena off while the market is data-only");
  const items = compact([
    jobItem(c, "arena-close", "Close the books", f.jobs["arena-close"], "Open the run history"),
    jobItem(
      c,
      "arena-signals",
      "Signals and orders",
      f.jobs["arena-signals"],
      "Open the run history",
    ),
    jobItem(c, "arena-review", "Review numbers", f.jobs["arena-review"], "Open the run history"),
  ]);
  return result(c, items, "Last nightly run completed");
}

function aiModels(f: HealthFacts): ComponentResult {
  const c = "ai_models";
  const items: HealthItem[] = [];
  if (f.llmLevel === "degrade") {
    items.push(
      item(c, "llm.degrade", "LLM budget exhausted; rule text only", "down", "Review LLM usage"),
    );
  } else if (f.llmLevel === "alert") {
    items.push(item(c, "llm.alert", "LLM budget nearly used", "attention", "Review LLM usage"));
  }
  return result(c, items, "Within budget");
}

function eveningEmail(f: HealthFacts): ComponentResult {
  const c = "evening_email";
  if (f.emailMode === "off") return result(c, [], "Email switch is off");
  const r = f.lastReview;
  if (!r) return result(c, [], "No review sent yet");
  if (r.status === "failed") {
    return result(
      c,
      [
        item(
          c,
          "review.failed",
          `Evening Review ${r.d} failed to send`,
          "down",
          "Open email controls and check the provider",
        ),
      ],
      "",
    );
  }
  if (r.status === "claimed" || r.status === "pending") {
    return result(
      c,
      [
        item(
          c,
          "review.stuck",
          `Evening Review ${r.d} not confirmed sent`,
          "attention",
          "Open email controls",
        ),
      ],
      "",
    );
  }
  return result(c, [], `Last review ${r.d} ${r.status}`);
}

function database(f: HealthFacts): ComponentResult {
  const c = "database";
  const items: HealthItem[] = [];
  if (!f.dbReadable)
    items.push(item(c, "db.unreadable", "Database not readable", "down", "Check Turso status"));
  if (f.storageLevel === "degrade") {
    items.push(
      item(
        c,
        "db.storage.full",
        "Database storage at the ceiling",
        "down",
        "Prune or raise the ceiling",
      ),
    );
  } else if (f.storageLevel === "alert") {
    items.push(
      item(c, "db.storage.high", "Database storage high", "attention", "Review storage use"),
    );
  }
  return result(c, items, "Reachable");
}

function backups(f: HealthFacts): ComponentResult {
  const c = "backups";
  return result(
    c,
    compact([
      jobItem(
        c,
        "nightly-backup",
        "Nightly backup",
        f.jobs["nightly-backup"],
        "Run the backup and check its log",
      ),
    ]),
    "Last backup succeeded",
  );
}

function security(f: HealthFacts): ComponentResult {
  const c = "security";
  const items: HealthItem[] = [];
  if (f.watchdog === "mismatch") {
    items.push(
      item(
        c,
        "watchdog.mismatch",
        "Deployed code differs from the approved commit",
        "down",
        "Open the code approval check",
      ),
    );
  } else if (f.watchdog === "awaiting_first_approval") {
    items.push(
      item(
        c,
        "watchdog.approval",
        "Waiting for the first code approval",
        "attention",
        "Approve the production commit",
      ),
    );
  }
  for (const s of [...f.failedSecrets].sort()) {
    const k = s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 60);
    items.push(
      item(
        c,
        `secret.${k}`,
        `Credential check failed: ${s}`,
        "down",
        "Rotate or re-enter the secret",
      ),
    );
  }
  for (const cr of [...f.credentials].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))) {
    const left = daysUntil(f.today, cr.expiresOn);
    if (left > CREDENTIAL_WARN_DAYS) continue;
    const key = `credential.${cr.name}`;
    items.push(
      left < 0
        ? item(
            c,
            key,
            `${cr.label} has expired`,
            "down",
            "Renew it and enter the new date",
            cr.expiresOn,
          )
        : item(
            c,
            key,
            `${cr.label} expires in ${left} day${left === 1 ? "" : "s"}`,
            "attention",
            "Renew it and enter the new date",
            cr.expiresOn,
          ),
    );
  }
  return result(c, items, "Code approved, credentials valid");
}

function freeTier(f: HealthFacts): ComponentResult {
  const c = "free_tier_limits";
  const items: HealthItem[] = [];
  if (f.quotaLevel === "degrade")
    items.push(item(c, "quota.degrade", "A free-tier limit is reached", "down", "Open Usage"));
  else if (f.quotaLevel === "alert")
    items.push(item(c, "quota.alert", "A free-tier limit is close", "attention", "Open Usage"));
  return result(c, items, "Well inside the limits");
}

const BUILDERS: Record<HealthComponent, (f: HealthFacts) => ComponentResult> = {
  sentinel,
  market_data: marketData,
  nightly_run: nightlyRun,
  ai_models: aiModels,
  evening_email: eveningEmail,
  database,
  backups,
  security,
  free_tier_limits: freeTier,
};

/** The nine components in the fixed UXN-283 order. */
export function computeComponents(f: HealthFacts): ComponentResult[] {
  return HEALTH_COMPONENTS.map((id) => BUILDERS[id](f));
}
