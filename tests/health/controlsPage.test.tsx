// BLD-024, DAT-120, DAT-123, O-23, O-26, ROL-102a: System Health "Data controls" section per role
// and the two-step confirmation form.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HealthPage from "@/app/(app)/health/page";
import { DataControlForm } from "@/app/(app)/health/DataControlForm";
import { SOURCE_CONTROLS, type ControlsView } from "@/lib/data/controls";

const requireUser = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() => vi.fn());
const actionMocks = vi.hoisted(() => ({
  confirmCalendarAction: vi.fn(),
  resetAsxTripAction: vi.fn(),
  setAsxEnabledAction: vi.fn(),
  setDispatchEnabledAction: vi.fn(),
  setMarketModeAction: vi.fn(),
  setSourceAcceptedAction: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/health/summary", () => ({ getHealthSummary: summaryMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}), authDb: () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) })); // Control Room client island
vi.mock("@/app/(app)/health/actions", () => actionMocks);

afterEach(cleanup);
beforeEach(() => {
  for (const m of Object.values(actionMocks)) m.mockReset();
});

type Result = { ok: true; changed: boolean } | { error: string };
const view = (over: Partial<ControlsView> = {}): ControlsView => ({
  dispatchEnabled: false,
  asxEnabled: false,
  asxTripped: false,
  sources: [
    { source: "asx_announcements", label: "ASX announcements", ref: "O-23", status: "pending" },
    {
      source: "yahoo_eod",
      label: "Yahoo Finance end-of-day prices",
      ref: "O-26",
      status: "pending",
    },
  ],
  markets: [{ market: "AU", mode: "data_only", configMode: "data_only", inSync: true }],
  dataOnly: true,
  calendarConfirmed: true,
  workerVars: { asxLive: "not known", asxUserAgent: "not known" },
  ...over,
});
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 1, email: "e@example.test", name: null, role });
const show = async (controls: ControlsView | null | undefined, extra: object = {}) => {
  summaryMock.mockResolvedValue({ jobs: [], controls, ...extra });
  render(await HealthPage());
};
const dd = (label: string) =>
  within(section())
    .getAllByText(label)
    .find((e) => e.tagName === "DT")?.nextSibling;
const section = () => screen.getByRole("region", { name: "Data controls" });

describe("status text (every role)", () => {
  it.each(["owner", "editor", "viewer"])(
    "%s sees the data-only banner and statuses",
    async (role) => {
      as(role);
      await show(view({ dispatchEnabled: true, asxEnabled: true }));
      const s = within(section());
      expect(s.getByText("Production data-only mode (BLD-024)")).toBeInTheDocument();
      expect(dd("Nightly dispatch")).toHaveTextContent("ON");
      expect(dd("ASX contact")).toHaveTextContent("ON");
      expect(dd("ASX announcements (O-23)")).toHaveTextContent("Not accepted yet");
      expect(dd("AU market mode")).toHaveTextContent("Data only");
    },
  );

  it.each(["editor", "viewer"])(
    "%s sees no buttons, no checkbox and no Worker-variable note",
    async (role) => {
      as(role);
      await show(view({ asxTripped: true, asxTrippedReason: "secret reason" }));
      const s = within(section());
      expect(s.queryAllByRole("button")).toHaveLength(0);
      expect(s.queryByRole("checkbox")).toBeNull();
      expect(s.queryByText(/ASX_LIVE/)).toBeNull();
      expect(s.queryByText(/secret reason/)).toBeNull();
      expect(s.queryByText("Open S2 incidents")).toBeNull();
    },
  );

  it("the banner is absent when the market is not in data-only mode", async () => {
    as("viewer");
    await show(
      view({
        dataOnly: false,
        markets: [{ market: "AU", mode: "off", configMode: "off", inSync: true }],
      }),
    );
    expect(screen.queryByText("Production data-only mode (BLD-024)")).toBeNull();
    expect(dd("AU market mode")).toHaveTextContent("Off");
  });

  it("hides the section when controls are missing or unreadable", async () => {
    as("owner");
    for (const controls of [undefined, null]) {
      await show(controls);
      expect(screen.queryByRole("region", { name: "Data controls" })).toBeNull();
      cleanup();
    }
  });
});

describe("Owner controls", () => {
  it("shows risk-accept buttons with the exact risk text, dispatch and ASX gated on the sources", async () => {
    as("owner");
    await show(view());
    const s = within(section());
    expect(
      s.getByText(/Last Worker report: ASX_LIVE not known, ASX_USER_AGENT not known/),
    ).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Accept risk (O-23)" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Accept risk (O-26)" })).toBeInTheDocument();
    expect(s.queryByRole("button", { name: "Turn dispatch on" })).toBeNull();
    expect(s.queryByRole("button", { name: "Turn ASX contact on" })).toBeNull();
    expect(s.getByText("Accept the Yahoo risk (O-26) before turning this on.")).toBeInTheDocument();
    expect(s.getByText("Accept the ASX risk (O-23) before turning this on.")).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Switch this market off" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Switch to full mode" })).toBeInTheDocument();
    fireEvent.click(s.getByRole("button", { name: "Accept risk (O-23)" }));
    expect(s.getByText(SOURCE_CONTROLS.asx_announcements.riskText)).toBeInTheDocument();
  });

  it("shows the Worker report values, and asks for the calendar before dispatch can be turned on", async () => {
    as("owner");
    const enabled = [
      { source: "asx_announcements", label: "ASX announcements", ref: "O-23", status: "enabled" },
      {
        source: "yahoo_eod",
        label: "Yahoo Finance end-of-day prices",
        ref: "O-26",
        status: "enabled",
      },
    ] as ControlsView["sources"];
    await show(
      view({
        sources: enabled,
        calendarConfirmed: false,
        workerVars: { asxLive: "set", asxUserAgent: "not set" },
      }),
    );
    const s = within(section());
    expect(s.getByText(/ASX_LIVE set, ASX_USER_AGENT not set/)).toBeInTheDocument();
    expect(s.queryByRole("button", { name: "Turn dispatch on" })).toBeNull();
    expect(s.getByText("Confirm the AU trading calendar first.")).toBeInTheDocument();
  });

  it("offers the switches once the sources are enabled, and disable buttons for them", async () => {
    as("owner");
    await show(
      view({
        sources: [
          {
            source: "asx_announcements",
            label: "ASX announcements",
            ref: "O-23",
            status: "enabled",
          },
          {
            source: "yahoo_eod",
            label: "Yahoo Finance end-of-day prices",
            ref: "O-26",
            status: "enabled",
          },
        ],
      }),
    );
    const s = within(section());
    expect(s.getByRole("button", { name: "Turn dispatch on" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Turn ASX contact on" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Disable ASX announcements" })).toBeInTheDocument();
    expect(s.queryByRole("button", { name: /Accept risk/ })).toBeNull();
  });

  it("offers 'off' buttons when the switches are on, and data-only when the market is off", async () => {
    as("owner");
    await show(
      view({
        dispatchEnabled: true,
        asxEnabled: true,
        markets: [{ market: "AU", mode: "off", configMode: "data_only", inSync: false }],
        dataOnly: false,
      }),
    );
    const s = within(section());
    expect(s.getByRole("button", { name: "Turn dispatch off" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Turn ASX contact off" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Set data-only mode" })).toBeInTheDocument();
    expect(s.getByText(/out of sync with the saved setting/)).toBeInTheDocument();
  });

  it("shows the trip reset button only when tripped, with the reason, and the open S2 incidents", async () => {
    as("owner");
    await show(view({ asxTripped: true, asxTrippedReason: "blocked 8 of 10" }), {
      heartbeatIncidents: [{ id: 3, at: "2026-10-12T00:31:00.000Z", kind: "worker_blind" }],
    });
    const s = within(section());
    expect(s.getByText(/stopped by the safety trip: blocked 8 of 10/)).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Reset ASX trip" })).toBeInTheDocument();
    expect(s.getByText(/worker blind — opened/)).toBeInTheDocument();
    cleanup();
    await show(view(), { heartbeatIncidents: [] });
    expect(within(section()).queryByRole("button", { name: "Reset ASX trip" })).toBeNull();
    expect(within(section()).getByText("None")).toBeInTheDocument();
    cleanup();
    await show(view(), { heartbeatIncidents: null });
    expect(within(section()).getByText("Incident list unavailable.")).toBeInTheDocument();
  });
});

describe("DataControlForm (confirmation step)", () => {
  const setup = (
    action: ReturnType<typeof vi.fn<(fd: FormData) => Promise<Result>>> = vi.fn(async () => ({
      ok: true as const,
      changed: true,
    })),
    checkbox?: string,
  ) => {
    render(
      <DataControlForm
        action={action}
        fields={{ enabled: "1" }}
        label="Turn it on"
        explain="This does the thing."
        checkbox={checkbox}
      />,
    );
    return action;
  };

  it("the first click only opens the explanation; nothing is sent", () => {
    const action = setup();
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    expect(screen.getByText("This does the thing.")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("Cancel closes the panel without sending", () => {
    const action = setup();
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("This does the thing.")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn it on" })).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("Confirm sends the hidden fields once and shows the result", async () => {
    const action = setup();
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Done."));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(fd.get("enabled")).toBe("1");
    expect(fd.get("acknowledged")).toBeNull();
  });

  it("an unchanged result says so", async () => {
    setup(vi.fn(async () => ({ ok: true as const, changed: false })));
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Nothing to change."));
  });

  it("a risk acceptance needs the box ticked before Confirm is enabled", async () => {
    const action = setup(undefined, "I accept this risk (O-23).");
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I accept this risk (O-23)." }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(fd.get("acknowledged")).toBe("on");
  });

  it("Cancel resets the box", () => {
    setup(undefined, "I accept.");
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("an error is shown in plain words, with no internals", async () => {
    setup(vi.fn(async () => ({ error: "source_pending" })));
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/has not been accepted yet/),
    );
  });
});
