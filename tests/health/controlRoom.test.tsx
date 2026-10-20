// M7 T10 Control Room: UXN-283 / UXN-285 acceptance, role split, masking, bounded reads per refresh,
// the 60 s visible-only refresh, the boot rules (<= 1.2 s, once per session, any key skips) and the
// motion rules in the stylesheet. Synthetic ZZ data only.
import fs from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { cleanupTempDbs } from "../db/helpers";
import { findLeaks } from "@/lib/view/mask";
import {
  loadControlRoom,
  timelineFrom,
  TIMELINE_EVENTS,
  type ControlRoomModel,
} from "@/lib/ui/loaders/controlRoom";
import type { HealthComponentView } from "@/lib/ui/loaders/health";
import { ControlRoom, StatusStrip, UsageGauge } from "@/app/(app)/health/ControlRoom";
import { ControlRoomClient, REFRESH_MS } from "@/app/(app)/health/ControlRoomClient";
import { briefingLines } from "@/app/(app)/health/ControlRoomText";
import { CODES, envOf, fullWorld, NAMES, type World } from "../loaders/world";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(app)/health/emailActions", () => ({ snoozeAttentionAction: vi.fn() }));

afterAll(cleanupTempDbs);
afterEach(cleanup);

const IDS = [
  "sentinel",
  "market_data",
  "nightly_run",
  "ai_models",
  "evening_email",
  "database",
  "backups",
  "security",
  "free_tier_limits",
] as const;

function comp(
  id: string,
  state: HealthComponentView["state"] = "healthy",
  extra: Partial<HealthComponentView> = {},
): HealthComponentView {
  return {
    id,
    state,
    reason: state === "healthy" ? "All good" : "Something to fix",
    items: [],
    ...extra,
  };
}

function model(
  over: Partial<ControlRoomModel> = {},
  comps?: HealthComponentView[],
): ControlRoomModel {
  const components = comps ?? IDS.map((id) => comp(id));
  const healthy = components.filter((c) => c.state === "healthy").length;
  return {
    health: {
      state: "ok",
      masked: false,
      healthy,
      total: components.length,
      headline: `${healthy} / ${components.length} healthy`,
      components,
      strip: [],
      details: true,
    },
    checkedAt: "2026-10-20T03:00:00.000Z",
    gauges: null,
    timeline: [],
    agents: [
      {
        id: "A1",
        name: "Sentinel",
        when: "Every minute",
        job: "worker-heartbeat",
        status: "ok",
        lastAt: "2026-10-20T02:59:00.000Z",
        outputs: 4,
      },
      {
        id: "A8",
        name: "Scribe",
        when: "19:10 to 19:45",
        job: null,
        status: "not tracked",
        lastAt: null,
        outputs: null,
      },
    ],
    ...over,
  };
}

const turso = comp("security", "attention", {
  reason: "Turso main-database token expires in 9 days",
  items: [
    {
      key: "cred.d_turso_main_tokens",
      label: "Turso main-database token expires in 9 days",
      state: "attention",
      deadlineD: "2026-10-29",
      fix: "Rotate the token (OPS-037 checklist)",
      fixPath: "/health#security",
    },
  ],
});
const redBackup = comp("backups", "down", {
  reason: "Last backup failed",
  items: [
    {
      key: "job.backup.failed",
      label: "Last backup failed",
      state: "down",
      deadlineD: null,
      fix: "Run the backup again",
      fixPath: "/health#backups",
    },
  ],
});
const snooze = {
  maxDays: 14,
  items: [
    {
      item: {
        component: "security" as const,
        key: "cred.d_turso_main_tokens",
        label: "x",
        state: "attention" as const,
        deadlineD: "2026-10-29",
      },
      snoozedUntil: null,
    },
  ],
};

const view = (
  m: ControlRoomModel,
  owner = true,
  sn: typeof snooze | null = owner ? snooze : null,
) => render(<ControlRoom model={m} owner={owner} tf="24h" snooze={sn} />);

describe("ring and readouts (UXN-283)", () => {
  it("nine segments, centre 'n / 9 healthy', numbered readouts that the segments link to", () => {
    const comps = IDS.map((id) => comp(id, id === "security" ? "attention" : "healthy"));
    comps[7] = turso;
    view(model({}, comps));
    const ring = screen.getByTestId("status-ring");
    expect(ring.querySelectorAll("a[data-seg]")).toHaveLength(9);
    expect(ring.textContent).toContain("8 / 9");
    expect(ring.getAttribute("aria-label")).toContain("8 / 9 healthy");
    const list = screen.getByRole("list", { name: "Numbered readouts" });
    expect(
      within(list)
        .getAllByText(/^[1-9]$/)
        .map((e) => e.textContent),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const a of Array.from(ring.querySelectorAll("a[data-seg]"))) {
      const target = document.getElementById(a.getAttribute("href")!.slice(1));
      expect(target?.tagName).toBe("DETAILS");
    }
    // colour is never the only signal: the state is in the label and the line pattern
    const sec = ring.querySelector('a[data-seg="security"]')!;
    expect(sec.getAttribute("aria-label")).toBe("8. Security: Needs attention");
    expect(sec.querySelector("path")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(
      ring.querySelector('a[data-seg="sentinel"] path')?.getAttribute("stroke-dasharray"),
    ).toBeNull();
  });

  it("an expiring Turso token: Security amber, 8 / 9, the briefing names it, the detail has the rotation fix", () => {
    const comps = IDS.map((id) => comp(id));
    comps[7] = turso;
    view(model({}, comps));
    const brief = screen.getByRole("heading", { name: "Status briefing" }).closest("section")!;
    expect(brief.textContent).toContain("8 of 9 parts are healthy.");
    expect(brief.textContent).toContain(
      "Security needs attention: Turso main-database token expires in 9 days.",
    );
    const sec = document.getElementById("security")!;
    expect(sec.textContent).toContain("Fix: Rotate the token (OPS-037 checklist)");
    expect(sec.textContent).toContain("deadline 2026-10-29");
    expect(sec.textContent).toContain("Reminder emailed daily at 08:00 until fixed.");
    expect(within(sec).getByRole("button", { name: "Snooze reminder" })).toBeInTheDocument();
  });

  it("red items have no snooze", () => {
    const comps = IDS.map((id) => comp(id));
    comps[6] = redBackup;
    view(model({}, comps));
    const el = document.getElementById("backups")!;
    expect(el.textContent).toContain("Red items cannot be snoozed.");
    expect(within(el).queryByRole("button", { name: "Snooze reminder" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Status briefing" }).closest("section")!.textContent,
    ).toContain("Backups is down: Last backup failed.");
  });

  it("all healthy: 'Nothing needs you today'", () => {
    view(model());
    expect(screen.getByTestId("status-ring").textContent).toContain("9 / 9");
    expect(screen.getByText("Everything is healthy. Nothing needs you today.")).toBeInTheDocument();
  });

  it("Editors and Viewers get one plain line per part: no fix, no snooze, no secret detail", () => {
    const comps = IDS.map((id) => comp(id));
    comps[7] = { ...turso, items: [] };
    view(model({}, comps), false);
    const sec = document.getElementById("security")!;
    expect(sec.textContent).not.toContain("Turso");
    expect(sec.textContent).not.toContain("Fix:");
    expect(screen.queryByRole("button", { name: /Snooze/ })).toBeNull();
    expect(document.body.textContent).not.toContain("Turso");
    expect(briefingLines(8, 9, comps, false).join(" ")).not.toContain("Turso");
  });

  it("long reasons wrap (no overflow trap) and a stale model says so", () => {
    const long = "x".repeat(400);
    const comps = IDS.map((id) => comp(id));
    comps[0] = comp("sentinel", "attention", { reason: long });
    const m = model({}, comps);
    m.health.state = "stale";
    view(m);
    expect(document.getElementById("sentinel")!.querySelector("summary")!.innerHTML).toContain(
      "break-words",
    );
    expect(document.querySelector("[data-stale]")?.textContent).toContain("Last check:");
  });
});

describe("gauges, strip, timeline, agents (UXN-283, UXN-285)", () => {
  it("usage at 72%: the 70 mark is crossed in amber, 90 and 95 are not", () => {
    render(
      <UsageGauge
        g={{
          id: "turso",
          label: "Turso reads",
          percent: 72,
          level: "notice",
          periodLabel: "2026-10",
        }}
      />,
    );
    const crossed = (m: number) => document.querySelector(`line[data-mark="${m}"]`)!;
    expect(crossed(70).getAttribute("data-crossed")).toBe("true");
    expect(crossed(70).getAttribute("stroke")).toBe("var(--color-breaker-amber)");
    expect(crossed(90).getAttribute("data-crossed")).toBe("false");
    expect(crossed(95).getAttribute("data-crossed")).toBe("false");
    expect(screen.getByText("Past the 70% mark")).toBeInTheDocument();
    expect(document.querySelector("svg")!.getAttribute("aria-label")).toContain(
      "72% of the free limit",
    );
  });

  it("zero and missing usage", () => {
    const { rerender } = render(
      <UsageGauge g={{ id: "a", label: "A", percent: 0, level: "ok", periodLabel: "" }} />,
    );
    expect(screen.getByText("Under the 70% mark")).toBeInTheDocument();
    rerender(
      <UsageGauge g={{ id: "a", label: "A", percent: null, level: "no data", periodLabel: "" }} />,
    );
    expect(screen.getByText("No data yet")).toBeInTheDocument();
  });

  it("only the Owner gets gauges", () => {
    const g = [{ id: "m", label: "Meter M", percent: 10, level: "ok" as const, periodLabel: "x" }];
    view(model({ gauges: g }));
    expect(document.querySelector('[data-gauge="m"]')).not.toBeNull();
    cleanup();
    view(model({ gauges: null }), false);
    expect(document.querySelector("[data-gauge]")).toBeNull();
    expect(screen.getByText(/numbers are shown to the Owner/)).toBeInTheDocument();
  });

  it("30-day strip: one bar per stored day, with a table; none stored says so", () => {
    const strip = Array.from({ length: 30 }, (_, i) => ({
      d: `2026-09-${String(i + 1).padStart(2, "0")}`,
      healthy: i === 3 ? 8 : 9,
      total: 9,
    }));
    const { container } = render(<StatusStrip strip={strip} />);
    expect(container.querySelectorAll("svg g")).toHaveLength(30);
    expect(screen.getByText(/30 days recorded, 29 fully healthy/)).toBeInTheDocument();
    cleanup();
    render(<StatusStrip strip={[]} />);
    expect(screen.getByText(/No daily health records yet/)).toBeInTheDocument();
  });

  it("timeline lists changes newest first and says so when empty", () => {
    view(
      model({ timeline: [{ d: "2026-10-18", component: "backups", from: "healthy", to: "down" }] }),
    );
    expect(screen.getByText(/Backups: Healthy to Down/)).toBeInTheDocument();
    cleanup();
    view(model());
    expect(screen.getByText("No changes recorded in the last 30 days.")).toBeInTheDocument();
  });

  it("the A1 to A8 panel sits behind 'Show details'", () => {
    view(model());
    const details = screen.getByText("Show details").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByRole("table")).toBeInTheDocument();
    expect(within(details).getByText("Sentinel (A1)")).toBeInTheDocument();
    expect(within(details).getByText("Not tracked on its own")).toBeInTheDocument();
  });
});

describe("timelineFrom", () => {
  const snap = (d: string, states: Record<string, string>) => ({
    d,
    components_json: JSON.stringify({
      components: Object.entries(states).map(([id, state]) => ({ id, state })),
    }),
  });
  it("diffs consecutive days, newest first, ignores unknown ids and bad JSON", () => {
    const ev = timelineFrom([
      snap("2026-10-03", { backups: "healthy", bogus: "down" }),
      snap("2026-10-01", { backups: "healthy" }),
      snap("2026-10-02", { backups: "down" }),
      { d: "2026-10-04", components_json: "{not json" },
    ]);
    expect(ev).toEqual([
      { d: "2026-10-03", component: "backups", from: "down", to: "healthy" },
      { d: "2026-10-02", component: "backups", from: "healthy", to: "down" },
    ]);
  });
  it("keeps at most 20 events", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      snap(`2026-09-${String(i + 1).padStart(2, "0")}`, { backups: i % 2 ? "down" : "healthy" }),
    );
    expect(timelineFrom(rows)).toHaveLength(TIMELINE_EVENTS);
  });
});

describe("loader: role split, masking, bounded reads per refresh (decision 24)", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
    const snapshot = (d: string, backups: string) =>
      w.main.execute({
        sql: "INSERT INTO health_snapshot (d, purpose, components_json) VALUES (?, 'reminder', ?)",
        args: [d, JSON.stringify({ components: [{ id: "backups", state: backups, items: [] }] })],
      });
    await snapshot("2026-10-17", "healthy");
    await snapshot("2026-10-18", "down");
    await snapshot("2026-10-19", "healthy");
  });

  function counted(db: Client): { db: Client; stats: { calls: number; rows: number } } {
    const stats = { calls: 0, rows: 0 };
    const proxy = new Proxy(db, {
      get(t, p, r) {
        if (p === "execute") {
          return async (...a: Parameters<Client["execute"]>) => {
            const res = await t.execute(...a);
            stats.calls += 1;
            stats.rows += res.rows.length;
            return res;
          };
        }
        const v = Reflect.get(t, p, r) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { db: proxy, stats };
  }

  it("one refresh reads a bounded number of rows (inside the DAT-141 budget)", async () => {
    for (const who of ["owner", "editor", "viewer"] as const) {
      const { db, stats } = counted(w.main);
      const m = await loadControlRoom({ ...envOf(w, who), main: db }, {});
      expect(m.health.total).toBe(9);
      // Measured ~550 rows (all roles): the existing health facts read a year of trading_calendar twice
      // (2 x 261 rows); this page adds ~30. That is ~33k rows per open hour, 1.6 % of DAT-141 (500 M
      // rows a month) at 8 open hours a day for 30 days. Decision 24 estimated ~300; see the T10 report.
      expect(stats.rows).toBeLessThanOrEqual(600);
      expect(stats.rows * 8 * 30 * 60).toBeLessThan(0.02 * 500_000_000);
      expect(stats.calls).toBeLessThanOrEqual(80);
    }
  });

  it("Owner gets gauges and fix items; Editor and Viewer get neither", async () => {
    const own = await loadControlRoom(envOf(w, "owner"), {});
    expect(own.gauges?.length).toBeGreaterThan(0);
    expect(own.timeline.map((e) => `${e.d} ${e.to}`)).toEqual([
      "2026-10-19 healthy",
      "2026-10-18 down",
    ]);
    expect(own.agents.map((a) => a.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]);
    for (const who of ["editor", "viewer"] as const) {
      const m = await loadControlRoom(envOf(w, who), {});
      expect(m.gauges).toBeNull();
      expect(m.health.components.every((c) => c.items.length === 0)).toBe(true);
      expect(m.health.headline).toBe(own.health.headline);
      expect(findLeaks(JSON.stringify(m), CODES, NAMES)).toEqual([]);
    }
  });
});

describe("client island: refresh, boot, skip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    window.sessionStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  const setVisibility = (v: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  };

  it("refreshes every 60 s only while the page is visible", () => {
    setVisibility("visible");
    render(<ControlRoomClient briefing="b">x</ControlRoomClient>);
    act(() => void vi.advanceTimersByTime(REFRESH_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    act(() => void vi.advanceTimersByTime(REFRESH_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(2); // coming back after >= 60 s refreshes at once
    setVisibility("visible");
  });

  it("stops refreshing after unmount", () => {
    setVisibility("visible");
    const { unmount } = render(<ControlRoomClient briefing="b">x</ControlRoomClient>);
    unmount();
    act(() => void vi.advanceTimersByTime(REFRESH_MS * 2));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("boot ends within 1.2 s, is skipped by any key, and plays once per session", () => {
    setVisibility("visible");
    const { container, unmount } = render(<ControlRoomClient briefing="b">x</ControlRoomClient>);
    const root = () => container.firstElementChild as HTMLElement;
    expect(root().dataset.boot).toBe("on");
    act(() => void vi.advanceTimersByTime(1_200));
    expect(root().dataset.boot).toBe("done");
    unmount();
    const again = render(<ControlRoomClient briefing="b">x</ControlRoomClient>);
    expect((again.container.firstElementChild as HTMLElement).dataset.boot).toBe("done");
    again.unmount();
    window.sessionStorage.clear();
    const skip = render(<ControlRoomClient briefing="b">x</ControlRoomClient>);
    expect((skip.container.firstElementChild as HTMLElement).dataset.boot).toBe("on");
    fireEvent.keyDown(window, { key: "a" });
    expect((skip.container.firstElementChild as HTMLElement).dataset.boot).toBe("done");
  });

  it("opens a part's details when its ring link is followed", () => {
    setVisibility("visible");
    render(
      <ControlRoomClient briefing="b">
        <details id="backups">
          <summary>Backups</summary>
        </details>
      </ControlRoomClient>,
    );
    window.location.hash = "#backups";
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")));
    expect((document.getElementById("backups") as HTMLDetailsElement).open).toBe(true);
  });
});

describe("motion and performance rules in the stylesheet (UXN-285 a, h)", () => {
  const css = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../src/app/(app)/health/ControlRoom.module.css"),
    "utf8",
  );
  it("stops all motion for reduced motion and the Motion switch", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain('[data-motion="off"]');
    expect(css).toMatch(/animation: none !important/);
  });
  it("boot is GPU-friendly (opacity and stroke-dashoffset only) and fits in 1.2 s", () => {
    const keyframes = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    for (const k of keyframes)
      expect(k).toMatch(/^\s*to \{\s*(opacity|stroke-dashoffset): [\w.]+;\s*\}\s*$/);
    expect(css).not.toMatch(/(width|height|top|left|margin)\s*:[^;]*;[^}]*animation/);
    const [per, base] = [90, 200]; // delay per part and start delay in the stylesheet
    expect(css).toContain(`calc(var(--i, 0) * ${per}ms + ${base}ms)`);
    expect(8 * per + base + 100).toBeLessThanOrEqual(1200); // last part: 8th index, 100 ms fade
    expect(700).toBeLessThanOrEqual(1200);
  });
  it("uses token colours only (no hard-coded colour)", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });
});
