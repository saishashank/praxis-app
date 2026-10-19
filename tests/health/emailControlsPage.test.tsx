// M5 T2: System Health "Email and alert controls" (docs/M5_design.md 4.12). Owner only; every
// change opens a confirmation panel first and sends nothing until "Confirm".
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HealthPage from "@/app/(app)/health/page";
import type { EmailControlsView } from "@/lib/data/controls";

const requireUser = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() => vi.fn());
const viewMock = vi.hoisted(() => vi.fn());
const attentionMock = vi.hoisted(() => vi.fn());
const emailActions = vi.hoisted(() => ({
  addWatchListCodeAction: vi.fn(),
  removeWatchListCodeAction: vi.fn(),
  setCredentialExpiryAction: vi.fn(),
  setEmailModeAction: vi.fn(),
  setEmailReviewTestDateAction: vi.fn(),
  snoozeAttentionAction: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/health/summary", () => ({ getHealthSummary: summaryMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}), authDb: () => ({}) }));
vi.mock("@/lib/health/attention", () => ({ loadAttentionItems: attentionMock }));
vi.mock("@/lib/data/controls", async (orig) => ({
  ...(await orig<typeof import("@/lib/data/controls")>()),
  loadEmailControlsView: viewMock,
}));
vi.mock("@/app/(app)/health/actions", () => ({
  confirmCalendarAction: vi.fn(),
  resetAsxTripAction: vi.fn(),
  setAsxEnabledAction: vi.fn(),
  setDispatchEnabledAction: vi.fn(),
  setMarketModeAction: vi.fn(),
  setSourceAcceptedAction: vi.fn(),
}));
vi.mock("@/app/(app)/health/emailActions", () => emailActions);

afterEach(cleanup);
beforeEach(() => {
  for (const m of Object.values(emailActions)) m.mockReset();
  viewMock.mockReset();
  attentionMock.mockReset().mockResolvedValue([]);
  summaryMock.mockReset().mockResolvedValue({ jobs: [], controls: null });
  requireUser.mockReset();
});

const view = (over: Partial<EmailControlsView> = {}): EmailControlsView => ({
  mode: "off",
  reviewTestDate: null,
  dataOnly: true,
  watchList: [],
  watchListMaxDays: 90,
  credentials: [
    { name: "d_turso_main_tokens", label: "(d) Turso main-database tokens", expiresOn: null },
    { name: "h_resend_api_keys", label: "(h) Resend API keys", expiresOn: "2027-05-01" },
  ],
  attention: [],
  attentionSnoozeMaxDays: 7,
  ...over,
});
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 1, email: "e@example.test", name: null, role });
const show = async (v: EmailControlsView | Error) => {
  if (v instanceof Error) viewMock.mockRejectedValue(v);
  else viewMock.mockResolvedValue(v);
  render(await HealthPage());
};
const section = () => screen.getByRole("region", { name: "Email and alert controls" });

describe("visibility", () => {
  it.each(["editor", "viewer"])(
    "%s sees no email controls and the view is never loaded",
    async (role) => {
      as(role);
      await show(view());
      expect(screen.queryByRole("region", { name: "Email and alert controls" })).toBeNull();
      expect(viewMock).not.toHaveBeenCalled();
    },
  );

  it("the Owner sees the section with the current mode, test date and credential dates", async () => {
    as("owner");
    await show(view({ mode: "incidents", reviewTestDate: "2026-10-21" }));
    const s = within(section());
    expect(s.getByText("Incidents only")).toBeInTheDocument();
    expect(s.getByText("2026-10-21")).toBeInTheDocument();
    expect(s.getByText("(h) Resend API keys")).toBeInTheDocument();
    expect(s.getByText("2027-05-01")).toBeInTheDocument();
    expect(s.getByText("no date set")).toBeInTheDocument();
  });

  it("an unreadable database shows 'unavailable' with no details", async () => {
    as("owner");
    await show(new Error("secret db detail"));
    expect(within(section()).getByText("Email controls are unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/secret db detail/)).toBeNull();
  });
});

describe("email mode", () => {
  it("full is not offered while a market is data-only; the other mode is", async () => {
    as("owner");
    await show(view({ dataOnly: true }));
    const s = within(section());
    expect(
      s.getByText(/Full email stays unavailable while a market is in data-only mode/),
    ).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Set email to: Incidents only" })).toBeInTheDocument();
    expect(s.queryByRole("button", { name: "Set email to: Full" })).toBeNull();
    expect(s.queryByRole("button", { name: /Set email to: Off/ })).toBeNull(); // already off
  });

  it("full is offered when no market is data-only", async () => {
    as("owner");
    await show(view({ dataOnly: false, mode: "incidents" }));
    const s = within(section());
    expect(s.getByRole("button", { name: "Set email to: Full" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: /Set email to: Off/ })).toBeInTheDocument();
  });

  it("nothing is sent until Confirm, then the action gets the chosen mode", async () => {
    as("owner");
    emailActions.setEmailModeAction.mockResolvedValue({ ok: true, changed: true });
    await show(view());
    fireEvent.click(
      within(section()).getByRole("button", { name: "Set email to: Incidents only" }),
    );
    expect(emailActions.setEmailModeAction).not.toHaveBeenCalled();
    const panel = screen.getByRole("group", { name: "Confirm: Set email to: Incidents only" });
    expect(panel).toHaveTextContent(/Only incident emails are sent/);
    fireEvent.click(within(panel).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(emailActions.setEmailModeAction).toHaveBeenCalledTimes(1));
    const fd = emailActions.setEmailModeAction.mock.calls[0][0] as FormData;
    expect(fd.get("mode")).toBe("incidents");
  });

  it("Cancel closes the panel without calling the action; an error shows plain text", async () => {
    as("owner");
    emailActions.setEmailModeAction.mockResolvedValue({ error: "data_only_market" });
    await show(view());
    fireEvent.click(
      within(section()).getByRole("button", { name: "Set email to: Incidents only" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(emailActions.setEmailModeAction).not.toHaveBeenCalled();
    fireEvent.click(
      within(section()).getByRole("button", { name: "Set email to: Incidents only" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/data-only mode/);
  });
});

describe("review test date, watch-list, credentials, snooze", () => {
  it("the test date control needs incidents mode", async () => {
    as("owner");
    await show(view({ mode: "off" }));
    expect(
      within(section()).getByText(/Set the email mode to incidents only first/),
    ).toBeInTheDocument();
    cleanup();
    await show(view({ mode: "incidents" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Set a test date" }));
    expect(screen.getByLabelText("Date")).toHaveAttribute("type", "date");
  });

  it("the watch-list shows entries with Remove, and Add sends the typed code and days after Confirm", async () => {
    as("owner");
    emailActions.addWatchListCodeAction.mockResolvedValue({ ok: true, changed: true });
    emailActions.removeWatchListCodeAction.mockResolvedValue({ ok: true, changed: true });
    await show(view({ watchList: [{ market: "AU", code: "ZZAA", expiresD: "2026-11-01" }] }));
    const s = within(section());
    expect(s.getByText("AU:ZZAA")).toBeInTheDocument();
    expect(s.getByText("until 2026-11-01")).toBeInTheDocument();
    fireEvent.click(s.getByRole("button", { name: "Remove ZZAA" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(emailActions.removeWatchListCodeAction).toHaveBeenCalledTimes(1));
    const rm = emailActions.removeWatchListCodeAction.mock.calls[0][0] as FormData;
    expect([rm.get("market"), rm.get("code")]).toEqual(["AU", "ZZAA"]);

    cleanup();
    await show(view());
    fireEvent.click(within(section()).getByRole("button", { name: "Add a code" }));
    fireEvent.change(screen.getByLabelText("Code (for example BHP)"), {
      target: { value: "ZZBB" },
    });
    expect(screen.getByLabelText("Days on the list")).toHaveValue(90);
    fireEvent.change(screen.getByLabelText("Days on the list"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(emailActions.addWatchListCodeAction).toHaveBeenCalledTimes(1));
    const add = emailActions.addWatchListCodeAction.mock.calls[0][0] as FormData;
    expect([add.get("market"), add.get("code"), add.get("days")]).toEqual(["AU", "ZZBB", "30"]);
  });

  it("the credential form lists every secret by name and sends the chosen name and date", async () => {
    as("owner");
    emailActions.setCredentialExpiryAction.mockResolvedValue({ ok: true, changed: true });
    await show(view());
    fireEvent.click(within(section()).getByRole("button", { name: "Set an expiry date" }));
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "h_resend_api_keys" } });
    fireEvent.change(screen.getByLabelText("Expires on"), { target: { value: "2027-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(emailActions.setCredentialExpiryAction).toHaveBeenCalledTimes(1));
    const fd = emailActions.setCredentialExpiryAction.mock.calls[0][0] as FormData;
    expect([fd.get("name"), fd.get("expires_on")]).toEqual(["h_resend_api_keys", "2027-06-30"]);
  });

  it("attention items: amber gets Snooze, red shows 'cannot be snoozed', a snoozed one shows its end", async () => {
    as("owner");
    emailActions.snoozeAttentionAction.mockResolvedValue({ ok: true, changed: true });
    const base = { component: "security" as const, state: "attention" as const, deadlineD: null };
    await show(
      view({
        attention: [
          { item: { ...base, key: "amber_one", label: "Amber thing" }, snoozedUntil: null },
          {
            item: { ...base, key: "red_one", label: "Red thing", state: "down" },
            snoozedUntil: null,
          },
          { item: { ...base, key: "done_one", label: "Quiet thing" }, snoozedUntil: "2026-10-22" },
        ],
      }),
    );
    const s = within(section());
    expect(s.getByText("cannot be snoozed")).toBeInTheDocument();
    expect(s.getByText("snoozed until 2026-10-22")).toBeInTheDocument();
    expect(s.getAllByRole("button", { name: "Snooze" })).toHaveLength(1);
    fireEvent.click(s.getByRole("button", { name: "Snooze" }));
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(emailActions.snoozeAttentionAction).toHaveBeenCalledTimes(1));
    const fd = emailActions.snoozeAttentionAction.mock.calls[0][0] as FormData;
    expect([fd.get("component"), fd.get("item_key"), fd.get("days")]).toEqual([
      "security",
      "amber_one",
      "3",
    ]);
  });

  it("with nothing to attend to the list says so", async () => {
    as("owner");
    await show(view());
    expect(within(section()).getByText("Nothing needs attention.")).toBeInTheDocument();
  });
});
