// M8 T11 pages: /ops/go-live (Owner only, guard first, own main and h1, checklist tick boxes, the
// sign-off button stays disabled until every box is ticked and the phrase is typed) and the System
// Health "Worker slots" block (Owner only; Editors and Viewers never see it).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GoLivePage from "@/app/(app)/ops/go-live/page";
import HealthPage from "@/app/(app)/health/page";
import { GoLiveForm } from "@/app/(app)/ops/go-live/GoLiveForm";
import { WorkerSlotsForm } from "@/app/(app)/health/WorkerSlotsForm";
import { GO_LIVE_ITEMS, SIGNOFF_CONFIRM_PHRASE, SIGNOFF_NOTE_MAX } from "@/lib/golive/checklist";
import { GO_LIVE_SLOTS } from "@/lib/golive/slots";
import { ROUTES } from "@/lib/ui/nav";

const requireUser = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/health/summary", () => ({ getHealthSummary: summaryMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => db, authDb: () => ({}) }));
vi.mock("@/lib/preferences/read", () => ({
  userPreferences: async () => ({ time_format: "24h" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/ops/go-live/actions", () => ({ signOffGoLiveAction: vi.fn() }));
vi.mock("@/app/(app)/health/slotsActions", () => ({ setSlotsEnabledAction: vi.fn() }));
vi.mock("@/app/(app)/health/actions", () => ({
  confirmCalendarAction: vi.fn(),
  resetAsxTripAction: vi.fn(),
  setAsxEnabledAction: vi.fn(),
  setDispatchEnabledAction: vi.fn(),
  setMarketModeAction: vi.fn(),
  setSourceAcceptedAction: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  requireUser.mockReset();
  summaryMock.mockReset().mockResolvedValue({ jobs: [], controls: null });
  db.execute.mockReset();
  vi.unstubAllEnvs();
});

const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 1, email: "e@example.test", name: null, role });

describe("/ops/go-live page", () => {
  it("is a route under Ops, guard first, and a non-Owner never reaches the data", async () => {
    expect(ROUTES.find((r) => r.pattern === "/ops/go-live")).toMatchObject({ parent: "/ops" });
    requireUser.mockRejectedValueOnce(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(GoLivePage()).rejects.toThrow(/403/);
    expect(requireUser).toHaveBeenCalledWith("admin", "/ops/go-live");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("shows its own main, an h1, every checklist item as a tick box and the phrase", async () => {
    as("owner");
    vi.stubEnv("APP_COMMIT", "abcdef1234");
    db.execute.mockImplementation(async ({ sql }: { sql: string }) => {
      if (sql.includes("go_live_signoff")) return { rows: [] };
      if (sql.includes("worker_state")) return { rows: [] };
      if (sql.includes("FROM market")) return { rows: [{ mode: "data_only" }] };
      return { rows: [] };
    });
    const { container } = render(await GoLivePage());
    expect(container.querySelectorAll("main").length).toBe(1);
    expect(screen.getByRole("heading", { level: 1, name: "Go-live sign-off" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(GO_LIVE_ITEMS.length);
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    for (const i of GO_LIVE_ITEMS) expect(screen.getByText(i.label)).toBeInTheDocument();
    expect(screen.getByText(SIGNOFF_CONFIRM_PHRASE)).toBeInTheDocument();
    expect(screen.getByText("abcdef1234")).toBeInTheDocument();
    expect(screen.getByText(/No sign-off has been recorded yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record the sign-off" })).toBeDisabled();
  });

  it("shows a neutral message when the data cannot be read", async () => {
    as("owner");
    db.execute.mockRejectedValue(new Error("db down: secret detail"));
    render(await GoLivePage());
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });
});

describe("GoLiveForm", () => {
  const items = GO_LIVE_ITEMS.map((i) => ({ ...i }));
  it("enables the button only with every box ticked and the exact phrase, then sends", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, changed: true });
    render(
      <GoLiveForm
        action={action}
        items={items}
        phrase={SIGNOFF_CONFIRM_PHRASE}
        noteMax={SIGNOFF_NOTE_MAX}
        askCommit={false}
      />,
    );
    const btn = screen.getByRole("button", { name: "Record the sign-off" });
    const phrase = screen.getByLabelText(/To sign off, type/);
    fireEvent.change(phrase, { target: { value: SIGNOFF_CONFIRM_PHRASE } });
    expect(btn).toBeDisabled(); // no boxes ticked
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(btn).toBeEnabled();
    fireEvent.change(phrase, { target: { value: "sign off go-live" } });
    expect(btn).toBeDisabled(); // wrong case
    fireEvent.change(phrase, { target: { value: SIGNOFF_CONFIRM_PHRASE } });
    // untick one: disabled again
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(btn);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0]![0] as FormData;
    expect(fd.getAll("item")).toEqual(GO_LIVE_ITEMS.map((i) => i.id));
    expect(fd.get("confirmation")).toBe(SIGNOFF_CONFIRM_PHRASE);
    expect(await screen.findByRole("status")).toHaveTextContent(/Sign-off recorded/);
  });

  it("asks for the commit only when the deployment does not report one, and shows refusals", async () => {
    const action = vi.fn().mockResolvedValue({ error: "signoff_required" });
    render(
      <GoLiveForm
        action={action}
        items={items}
        phrase={SIGNOFF_CONFIRM_PHRASE}
        noteMax={SIGNOFF_NOTE_MAX}
        askCommit
      />,
    );
    expect(screen.getByLabelText(/Release commit/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/To sign off, type/), {
      target: { value: SIGNOFF_CONFIRM_PHRASE },
    });
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Record the sign-off" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/go-live sign-off/);
  });
});

describe("System Health Worker slots block", () => {
  const show = async () => render(await HealthPage());
  const slotReads = () =>
    db.execute.mock.calls.filter((c) =>
      (c[0] as { args?: unknown[] }).args?.includes("slots_enabled"),
    );
  const block = () => screen.queryByRole("region", { name: "Worker slots" });

  it.each(["editor", "viewer"])(
    "%s never sees the block and the list is never read",
    async (role) => {
      as(role);
      await show();
      expect(block()).toBeNull();
      expect(screen.queryByText(/Save the list/)).toBeNull();
      expect(slotReads()).toEqual([]);
    },
  );

  it("the Owner sees every go-live slot, the saved list and the always-run statement", async () => {
    as("owner");
    db.execute.mockImplementation(async ({ args }: { args?: unknown[] }) =>
      args?.includes("slots_enabled") ? { rows: [{ value_json: '["morning"]' }] } : { rows: [] },
    );
    await show();
    const b = block()!;
    expect(b).not.toBeNull();
    expect(within(b).getAllByRole("checkbox", { name: /\(/ }).length).toBe(GO_LIVE_SLOTS.length);
    expect(within(b).getByRole("checkbox", { name: /Morning email/ })).toBeChecked();
    expect(within(b).getByRole("checkbox", { name: /Evening review \(/ })).not.toBeChecked();
    expect(b).toHaveTextContent(/Backup, maintenance and the daily import/);
    expect(b).toHaveTextContent(/always run/);
    expect(b).toHaveTextContent(/Saved list: morning/);
    expect(within(b).getByRole("button", { name: "Save the list" })).toBeDisabled();
  });

  it("an unreadable list says so and a read failure shows a neutral line", async () => {
    as("owner");
    db.execute.mockResolvedValue({ rows: [{ value_json: "{bad" }] });
    await show();
    expect(block()).toHaveTextContent(/cannot be read, so the Worker starts nothing new/);
    cleanup();
    db.execute.mockRejectedValue(new Error("db down: secret detail"));
    await show();
    expect(block()).toHaveTextContent(/slot list is unavailable/);
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });
});

describe("WorkerSlotsForm", () => {
  const slots = GO_LIVE_SLOTS.map((s) => ({ ...s }));
  it("sends the ticked slots and the confirmation only after the confirm box is ticked", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, changed: true });
    render(<WorkerSlotsForm action={action} slots={slots} initial={["morning"]} />);
    const save = screen.getByRole("button", { name: "Save the list" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Pre-open re-check, attempt 1/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0]![0] as FormData;
    expect(fd.getAll("slot")).toEqual(["morning", "pre-open"]);
    expect(fd.get("confirm")).toBe("yes");
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });
});
