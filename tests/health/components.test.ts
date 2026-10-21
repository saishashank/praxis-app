// @vitest-environment node
// The nine health components (M5 T13, UXN-283, decision 28): each component's healthy / attention /
// down states from synthetic facts, and the snapshot JSON shape the snooze reader (attention.ts,
// D-097) parses. Pure functions; no database.
import { describe, expect, it } from "vitest";
import { parseAttentionItems } from "@/lib/health/attention";
import { computeComponents, type ComponentResult, type HealthFacts } from "@/lib/health/components";
import { buildSnapshot, snoozeApplies } from "@/lib/health/snapshot";
import { HEALTH_COMPONENTS } from "@/lib/sentinel/schema";

const TODAY = "2026-10-18";
const NOW = Date.parse("2026-10-17T21:00:00Z");
const green = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  today: TODAY,
  nowMs: NOW,
  marketActive: true,
  sentinelLastOkAt: "2026-10-17T20:00:00Z",
  jobs: {},
  quality: { gateFails: 0, blockingFlags: 0 },
  llmLevel: "ok",
  emailMode: "full",
  lastReview: { d: "2026-10-16", status: "sent" },
  dbReadable: true,
  storageLevel: "ok",
  watchdog: "ok",
  failedSecrets: [],
  credentials: [],
  quotaLevel: "ok",
  ...over,
});
const by = (r: ComponentResult[], id: string) => r.find((c) => c.id === id)!;

describe("nine components", () => {
  it("returns the nine ids in order, all healthy on green facts", () => {
    const r = computeComponents(green());
    expect(r.map((c) => c.id)).toEqual([...HEALTH_COMPONENTS]);
    expect(r.every((c) => c.state === "healthy" && c.items.length === 0)).toBe(true);
    expect(r.every((c) => c.reason.length > 0)).toBe(true);
  });

  it("sentinel: off in data-only, amber when late, red when silent, amber before the first poll", () => {
    expect(
      by(computeComponents(green({ marketActive: false, sentinelLastOkAt: null })), "sentinel")
        .state,
    ).toBe("healthy");
    expect(by(computeComponents(green({ sentinelLastOkAt: null })), "sentinel").state).toBe(
      "attention",
    );
    expect(
      by(computeComponents(green({ sentinelLastOkAt: "2026-10-15T00:00:00Z" })), "sentinel").state,
    ).toBe("attention");
    expect(
      by(computeComponents(green({ sentinelLastOkAt: "2026-10-10T00:00:00Z" })), "sentinel").state,
    ).toBe("down");
  });

  it("market_data: a failed ingest is red, a stale import amber, quality gate and flags amber, unreadable quality amber", () => {
    expect(
      by(computeComponents(green({ jobs: { "ingest-batch1": "failed" } })), "market_data").state,
    ).toBe("down");
    expect(
      by(computeComponents(green({ jobs: { "universe-import": "stale" } })), "market_data").state,
    ).toBe("attention");
    expect(
      by(computeComponents(green({ jobs: { "ingest-batch1": "no data" } })), "market_data").state,
    ).toBe("healthy");
    const q = by(
      computeComponents(green({ quality: { gateFails: 1, blockingFlags: 3 } })),
      "market_data",
    );
    expect(q.items.map((i) => i.key)).toEqual(["quality.gate", "quality.flags"]);
    expect(by(computeComponents(green({ quality: null })), "market_data").state).toBe("attention");
  });

  it("nightly_run: ignored while data-only, red on a failed run, amber when overdue", () => {
    expect(
      by(
        computeComponents(green({ marketActive: false, jobs: { "arena-close": "failed" } })),
        "nightly_run",
      ).state,
    ).toBe("healthy");
    expect(
      by(computeComponents(green({ jobs: { "arena-close": "failed" } })), "nightly_run").state,
    ).toBe("down");
    expect(
      by(computeComponents(green({ jobs: { "arena-review": "stale" } })), "nightly_run").state,
    ).toBe("attention");
  });

  it("ai_models: alert amber, degrade red", () => {
    expect(by(computeComponents(green({ llmLevel: "notice" })), "ai_models").state).toBe("healthy");
    expect(by(computeComponents(green({ llmLevel: "alert" })), "ai_models").state).toBe(
      "attention",
    );
    expect(by(computeComponents(green({ llmLevel: "degrade" })), "ai_models").state).toBe("down");
  });

  it("evening_email: off healthy, failed red, stuck amber, sent healthy", () => {
    expect(
      by(
        computeComponents(green({ emailMode: "off", lastReview: { d: "x", status: "failed" } })),
        "evening_email",
      ).state,
    ).toBe("healthy");
    expect(
      by(
        computeComponents(green({ lastReview: { d: "2026-10-16", status: "failed" } })),
        "evening_email",
      ).state,
    ).toBe("down");
    expect(
      by(
        computeComponents(green({ lastReview: { d: "2026-10-16", status: "claimed" } })),
        "evening_email",
      ).state,
    ).toBe("attention");
    expect(by(computeComponents(green({ lastReview: null })), "evening_email").state).toBe(
      "healthy",
    );
  });

  it("database: unreadable red, storage alert amber, storage degrade red", () => {
    expect(by(computeComponents(green({ dbReadable: false })), "database").state).toBe("down");
    expect(by(computeComponents(green({ storageLevel: "alert" })), "database").state).toBe(
      "attention",
    );
    expect(by(computeComponents(green({ storageLevel: "degrade" })), "database").state).toBe(
      "down",
    );
  });

  it("backups: failed red, stale amber, no data healthy", () => {
    expect(
      by(computeComponents(green({ jobs: { "nightly-backup": "failed" } })), "backups").state,
    ).toBe("down");
    expect(
      by(computeComponents(green({ jobs: { "nightly-backup": "stale" } })), "backups").state,
    ).toBe("attention");
    expect(
      by(computeComponents(green({ jobs: { "nightly-backup": "no data" } })), "backups").state,
    ).toBe("healthy");
  });

  it("security: watchdog, failed secret, credential 12 days away amber with deadline, expired red", () => {
    expect(by(computeComponents(green({ watchdog: "mismatch" })), "security").state).toBe("down");
    expect(
      by(computeComponents(green({ watchdog: "awaiting_first_approval" })), "security").state,
    ).toBe("attention");
    expect(
      by(computeComponents(green({ failedSecrets: ["TURSO_MAIN_TOKEN"] })), "security").state,
    ).toBe("down");
    const amber = by(
      computeComponents(
        green({
          credentials: [
            { name: "d_turso_main_tokens", label: "Turso tokens", expiresOn: "2026-10-30" },
          ],
        }),
      ),
      "security",
    );
    expect(amber.state).toBe("attention");
    expect(amber.items[0]).toMatchObject({
      key: "credential.d_turso_main_tokens",
      deadline_d: "2026-10-30",
      state: "attention",
    });
    expect(amber.items[0]!.label).toContain("12 days");
    const far = computeComponents(
      green({ credentials: [{ name: "x", label: "X", expiresOn: "2027-01-01" }] }),
    );
    expect(by(far, "security").state).toBe("healthy");
    const gone = computeComponents(
      green({ credentials: [{ name: "x", label: "X", expiresOn: "2026-10-01" }] }),
    );
    expect(by(gone, "security").items[0]!.state).toBe("down");
  });

  it("free_tier_limits: alert amber, degrade red", () => {
    expect(by(computeComponents(green({ quotaLevel: "alert" })), "free_tier_limits").state).toBe(
      "attention",
    );
    expect(by(computeComponents(green({ quotaLevel: "degrade" })), "free_tier_limits").state).toBe(
      "down",
    );
  });

  it("a red item makes the component red even beside an amber one", () => {
    const c = by(
      computeComponents(green({ jobs: { "ingest-batch1": "failed", "universe-import": "stale" } })),
      "market_data",
    );
    expect(c.state).toBe("down");
    expect(c.items).toHaveLength(2);
  });
});

describe("snapshot JSON shape (D-097)", () => {
  const facts = green({
    jobs: { "ingest-batch1": "failed" },
    credentials: [{ name: "d_turso_main_tokens", label: "Turso tokens", expiresOn: "2026-10-30" }],
  });

  it("parseAttentionItems reads exactly what the writer produces", () => {
    const snap = buildSnapshot(computeComponents(facts), null, TODAY);
    const parsed = parseAttentionItems(JSON.stringify(snap));
    expect(parsed).toEqual([
      {
        component: "market_data",
        key: "job.ingest-batch1.failed",
        label: "End-of-day ingest: last run failed",
        state: "down",
        deadlineD: null,
      },
      {
        component: "security",
        key: "credential.d_turso_main_tokens",
        label: expect.stringContaining("12 days"),
        state: "attention",
        deadlineD: "2026-10-30",
      },
    ]);
    expect(snap.components).toHaveLength(9);
    for (const c of snap.components) expect(["healthy", "attention", "down"]).toContain(c.state);
  });

  it("since_d carries over from the previous snapshot while the item stays open", () => {
    const first = buildSnapshot(computeComponents(facts), null, "2026-10-16");
    const second = buildSnapshot(computeComponents(facts), first, TODAY);
    const it = second.components.find((c) => c.id === "market_data")!.items[0]!;
    expect(it.since_d).toBe("2026-10-16");
  });

  it("snoozeApplies: amber only, and not within 2 days of the deadline", () => {
    expect(snoozeApplies({ state: "attention", deadline_d: null }, TODAY)).toBe(true);
    expect(snoozeApplies({ state: "down", deadline_d: null }, TODAY)).toBe(false);
    expect(snoozeApplies({ state: "attention", deadline_d: "2026-10-20" }, TODAY)).toBe(false);
    expect(snoozeApplies({ state: "attention", deadline_d: "2026-10-21" }, TODAY)).toBe(true);
  });
});
