import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The shell mounts the ToastProvider; the page tests do the same.
const render = (ui: ReactElement) => rtlRender(<ToastProvider>{ui}</ToastProvider>);

const requireUser = vi.hoisted(() => vi.fn());
const svc = vi.hoisted(() => ({
  listUsers: vi.fn(),
  getSharingAck: vi.fn(),
  listAudit: vi.fn(),
  listGrants: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/db/client", () => ({ authDb: () => ({}) }));
vi.mock("@/lib/users/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/users/service")>()),
  ...svc,
}));
const actions = vi.hoisted(() => ({
  addUserAction: vi.fn(async () => ({ ok: true })),
  changeRoleAction: vi.fn(async () => ({ ok: true })),
  recordSharingAckAction: vi.fn<(fd: FormData) => Promise<{ ok: boolean }>>(async () => ({
    ok: true,
  })),
  revokeUserAction: vi.fn(async () => ({ ok: true })),
  signOutEverywhereAction: vi.fn(async () => ({ ok: true })),
  grantUnmaskAction: vi.fn(async () => ({ ok: true })),
  revokeUnmaskAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/users/actions", () => actions);

import UsersPage from "@/app/(app)/users/page";
import { ActionForm } from "@/app/(app)/users/ActionForm";
import { ActionSheet } from "@/app/(app)/users/ActionSheet";
import { ToastProvider } from "@/components/ui/Toast";
import { ACK_TEXT } from "@/lib/users/ack";

const T = "2026-10-10T12:00:00.000Z";
const u = (id: number, email: string, role: string, status: string) => ({
  id,
  email,
  name: null,
  role,
  status,
  updatedAt: T,
});
const users = [
  u(1, "owner@example.test", "owner", "active"),
  u(2, "ed@example.test", "editor", "active"),
  u(3, "inv@example.test", "viewer", "invited"),
  u(4, "gone@example.test", "viewer", "revoked"),
];
const ev = (
  id: number,
  action: string,
  actorUserId: number | null,
  targetType: string | null,
  targetId: string | null,
  detailJson: string | null,
) => ({ id, at: T, action, actorUserId, targetType, targetId, detailJson });
const events = [
  ev(3, "user.add", 1, "app_user", "2", '{"role":"editor"}'),
  ev(2, "sharing.ack", 1, "market", "AU", null),
  ev(1, "auth.signin_refused", null, null, null, null),
  ev(0, "auth.signin_success", 77, "app_user", "88", null),
];
const ack = { market: "AU", acknowledgedBy: 1, acknowledgedAt: T, textVersion: "v1" };
const submit = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.submit(el.closest("form")!);
  });
};

beforeAll(async () => {
  await import("@/components/ui/SheetPanel");
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: 1, email: "owner@example.test", name: null, role: "owner" });
  svc.listUsers.mockResolvedValue(users);
  svc.listAudit.mockResolvedValue(events);
  svc.getSharingAck.mockResolvedValue(null);
  svc.listGrants.mockResolvedValue([]);
});

describe("users page", () => {
  it("requires the admin action on /users", async () => {
    render(await UsersPage());
    expect(requireUser).toHaveBeenCalledWith("admin", "/users");
  });

  it("a refused guard stops the page before any data is read", async () => {
    requireUser.mockRejectedValueOnce(new Error("403"));
    await expect(UsersPage()).rejects.toThrow("403");
    expect(svc.listUsers).not.toHaveBeenCalled();
  });

  it("without the acknowledgement: Add user is disabled with the hint (AT-01)", async () => {
    render(await UsersPage());
    const add = screen.getByRole("button", { name: "Add user" });
    expect(add).toBeDisabled();
    expect(screen.getByText("Acknowledge sharing first")).toBeInTheDocument();
    expect(add).toHaveAccessibleDescription("Acknowledge sharing first");
    expect(screen.getByText(ACK_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeRequired();
    expect(screen.getByRole("button", { name: "Record acknowledgement" })).toBeEnabled();
  });

  it("with the acknowledgement: Add user enabled, no hint, no ack form", async () => {
    svc.getSharingAck.mockResolvedValue(ack);
    render(await UsersPage());
    expect(screen.getByRole("button", { name: "Add user" })).toBeEnabled();
    expect(screen.queryByText("Acknowledge sharing first")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record acknowledgement" })).toBeNull();
    expect(
      screen.getByText(/Recorded 2026-10-10 23:00 AEDT by owner@example.test/),
    ).toBeInTheDocument();
  });

  it("add form defaults the role to Viewer and offers no Owner", async () => {
    svc.getSharingAck.mockResolvedValue(ack);
    render(await UsersPage());
    const sel = within(screen.getByRole("region", { name: "Add user" })).getByLabelText("Role");
    expect(sel).toHaveValue("viewer");
    expect([...(sel as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      "viewer",
      "editor",
    ]);
    expect(screen.getByLabelText("Google email")).toBeRequired();
  });

  it("users table: actions are buttons; Owner has no Change role or Revoke; revoked rows have no controls", async () => {
    svc.getSharingAck.mockResolvedValue(ack);
    render(await UsersPage());
    const row = (email: string) => screen.getByRole("rowheader", { name: email }).closest("tr")!;
    const owner = within(row("owner@example.test"));
    expect(owner.queryByRole("combobox")).toBeNull();
    expect(owner.queryByRole("button", { name: /^Revoke/ })).toBeNull();
    expect(owner.queryByRole("button", { name: /^Change role/ })).toBeNull();
    expect(owner.getByText("Owner")).toBeInTheDocument();
    expect(owner.getByRole("button", { name: /Sign out everywhere/ })).toBeInTheDocument();
    const ed = within(row("ed@example.test"));
    expect(ed.getByText("Editor")).toBeInTheDocument();
    expect(ed.getByRole("button", { name: /^Change role/ })).toBeInTheDocument();
    expect(ed.getByRole("button", { name: /^Sign out everywhere/ })).toBeInTheDocument();
    expect(ed.getByRole("button", { name: /^Revoke/ })).toBeInTheDocument();
    // nothing in a row changes anything by itself: no select until a sheet is open
    expect(ed.queryByRole("combobox")).toBeNull();
    expect(within(row("inv@example.test")).getByText("Invited")).toBeInTheDocument();
    const gone = within(row("gone@example.test"));
    expect(gone.getByText("Revoked")).toBeInTheDocument();
    expect(gone.queryByRole("button")).toBeNull();
    expect(gone.queryByRole("combobox")).toBeNull();
    expect(screen.getAllByText("2026-10-10 23:00 AEDT").length).toBeGreaterThan(0);
  });

  it("Change role opens a sheet with the select and one primary Save role", async () => {
    render(await UsersPage());
    fireEvent.click(screen.getAllByRole("button", { name: /^Change role/ })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Change role for ed@example.test" });
    expect(within(dialog).getByLabelText("Role for ed@example.test")).toHaveValue("editor");
    expect(within(dialog).getAllByRole("button", { name: "Save role" })).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save role" }));
    });
    await waitFor(() => expect(actions.changeRoleAction).toHaveBeenCalledTimes(1));
    const fd = (actions.changeRoleAction.mock.calls[0] as unknown as [FormData])[0];
    expect(fd.get("userId")).toBe("2");
    expect(fd.get("role")).toBe("editor");
  });

  it("the audit log is no longer here; it links to its own page (D-174)", async () => {
    render(await UsersPage());
    expect(svc.listAudit).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Audit log" })).toBeNull();
    expect(screen.getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/audit");
  });

  it("shows the simulation footer", async () => {
    render(await UsersPage());
    expect(
      screen.getByText("Simulation for personal information only — not financial advice"),
    ).toBeInTheDocument();
  });

  it("submitting the acknowledgement calls the action with the checkbox", async () => {
    render(await UsersPage());
    fireEvent.click(screen.getByRole("checkbox"));
    await submit(screen.getByRole("button", { name: "Record acknowledgement" }));
    expect(actions.recordSharingAckAction).toHaveBeenCalledTimes(1);
    expect(actions.recordSharingAckAction.mock.calls[0][0].get("acknowledge")).toBe("on");
  });
});

describe("ActionForm", () => {
  it("shows the message for a returned error code and calls onSuccess on success", async () => {
    const onSuccess = vi.fn();
    const { rerender } = render(
      <ActionForm action={async () => ({ error: "exists" })} onSuccess={onSuccess}>
        <button type="submit">Go</button>
      </ActionForm>,
    );
    await submit(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("That address is already on the list.");
    expect(onSuccess).not.toHaveBeenCalled();
    rerender(
      <ActionForm action={async () => ({ ok: true as const })} onSuccess={onSuccess}>
        <button type="submit">Go</button>
      </ActionForm>,
    );
    await submit(screen.getByRole("button", { name: "Go" }));
    expect(onSuccess).toHaveBeenCalled();
  });

  it("an unknown code falls back to the generic message; onSuccess is optional", async () => {
    const a = render(
      <ActionForm action={async () => ({ error: "weird" })}>
        <button type="submit">Go</button>
      </ActionForm>,
    );
    await submit(a.getByRole("button", { name: "Go" }));
    expect(a.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    const b = render(
      <ActionForm action={async () => ({ ok: true as const })}>
        <button type="submit">Ok</button>
      </ActionForm>,
    );
    await submit(b.getByRole("button", { name: "Ok" }));
    expect(within(b.container).queryByRole("alert")).toBeNull();
  });
});

describe("ActionSheet (confirm sheets, UXR-029)", () => {
  const open = async (props: Partial<ComponentProps<typeof ActionSheet>> = {}) => {
    const action = (props.action ?? vi.fn(async () => ({ ok: true as const }))) as (
      fd: FormData,
    ) => Promise<{ ok: true }>;
    render(
      <ActionSheet
        label="Revoke"
        forWhom="ed@example.test"
        title="Revoke access for ed@example.test?"
        description="They are not emailed."
        submitLabel="Revoke access"
        danger
        doneText="Access revoked"
        action={action}
        {...props}
      >
        <input type="hidden" name="userId" value="2" />
      </ActionSheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Revoke/ }));
    return { action, dialog: await screen.findByRole("dialog") };
  };

  it("opens a sheet naming the user and saying they are not emailed; one primary action", async () => {
    const { dialog } = await open();
    expect(dialog).toHaveAccessibleName("Revoke access for ed@example.test?");
    expect(within(dialog).getByText("They are not emailed.")).toBeInTheDocument();
    const primary = within(dialog).getByRole("button", { name: "Revoke access" });
    expect(primary.className).toContain("bg-danger"); // red only inside the confirm sheet
    // the only buttons are the sheet's close control and the primary action
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Close", "Revoke access"]);
  });

  it("the trigger on the page is not red", () => {
    render(
      <ActionSheet label="Revoke" title="t" submitLabel="Go" danger action={vi.fn()} doneText="x">
        <span />
      </ActionSheet>,
    );
    expect(screen.getByRole("button", { name: "Revoke" }).className).not.toContain("bg-danger");
  });

  it("Esc closes it without calling the action", async () => {
    const { action } = await open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).not.toHaveBeenCalled();
  });

  it("the primary action submits the user id, closes the sheet and toasts", async () => {
    const action = vi.fn<(fd: FormData) => Promise<{ ok: true }>>(async () => ({
      ok: true as const,
    }));
    const { dialog } = await open({ action });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]![0].get("userId")).toBe("2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Access revoked")).toBeInTheDocument();
  });

  it("stays open and shows the error when the action refuses", async () => {
    const action = vi.fn<(fd: FormData) => Promise<{ error: string }>>(async () => ({
      error: "owner_protected",
    }));
    const { dialog } = await open({ action: action as never });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("The Owner cannot be changed here.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("unmask grants section (UX-009, ROL-107)", () => {
  const FAR = "2099-01-01T00:00:00.000Z";
  const grant = (id: number, userId: number, expiresAt: string, revokedAt: string | null) => ({
    id,
    userId,
    grantedBy: 1,
    grantedAt: T,
    expiresAt,
    revokedAt,
    revokedBy: revokedAt === null ? null : 1,
  });

  it("lists grantable users (not the Owner, not revoked) and says No grants yet", async () => {
    render(await UsersPage());
    const sec = screen.getByRole("heading", { name: "Unmask grants" }).closest("section")!;
    const options = within(sec)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["ed@example.test", "inv@example.test"]);
    expect(within(sec).getByText("No grants yet.")).toBeInTheDocument();
    expect(within(sec).getByRole("button", { name: "Grant unmask" })).toBeEnabled();
  });

  it("shows Live (with Revoke), Expired and Revoked rows; only a live grant can be revoked", async () => {
    svc.listGrants.mockResolvedValue([
      grant(3, 2, FAR, null),
      grant(2, 3, "2020-01-01T00:00:00.000Z", null),
      grant(1, 2, FAR, "2026-10-01T00:00:00.000Z"),
    ]);
    render(await UsersPage());
    const sec = screen.getByRole("heading", { name: "Unmask grants" }).closest("section")!;
    const rows = within(sec).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[2]!.textContent)).toEqual([
      "Live",
      "Expired",
      "Revoked",
    ]);
    expect(within(sec).getAllByRole("button", { name: /^Revoke/ })).toHaveLength(1);
  });

  it("submits the grant form to grantUnmaskAction and a revoke (via its confirm sheet) to revokeUnmaskAction", async () => {
    svc.listGrants.mockResolvedValue([grant(3, 2, FAR, null)]);
    render(await UsersPage());
    await submit(screen.getByRole("button", { name: "Grant unmask" }));
    expect(actions.grantUnmaskAction).toHaveBeenCalledTimes(1);
    const sec = screen.getByRole("heading", { name: "Unmask grants" }).closest("section")!;
    fireEvent.click(within(sec).getByRole("button", { name: /^Revoke/ }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revoke grant" }));
    });
    await waitFor(() => expect(actions.revokeUnmaskAction).toHaveBeenCalledTimes(1));
  });
});
