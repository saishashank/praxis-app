import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const svc = vi.hoisted(() => ({
  listUsers: vi.fn(),
  getSharingAck: vi.fn(),
  listAudit: vi.fn(),
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
}));
vi.mock("@/app/(app)/users/actions", () => actions);

import UsersPage from "@/app/(app)/users/page";
import { ActionForm } from "@/app/(app)/users/ActionForm";
import { RevokeButton } from "@/app/(app)/users/RevokeButton";
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

beforeAll(() => {
  // jsdom has no modal dialog support.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: 1, email: "owner@example.test", name: null, role: "owner" });
  svc.listUsers.mockResolvedValue(users);
  svc.listAudit.mockResolvedValue(events);
  svc.getSharingAck.mockResolvedValue(null);
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

  it("users table: Owner has no role select or Revoke; revoked rows have no controls", async () => {
    svc.getSharingAck.mockResolvedValue(ack);
    render(await UsersPage());
    const row = (email: string) => screen.getByRole("rowheader", { name: email }).closest("tr")!;
    const owner = within(row("owner@example.test"));
    expect(owner.queryByRole("combobox")).toBeNull();
    expect(owner.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(owner.getByText("Owner")).toBeInTheDocument();
    expect(owner.getByRole("button", { name: /Sign out everywhere/ })).toBeInTheDocument();
    const ed = within(row("ed@example.test"));
    expect(ed.getByLabelText("Role for ed@example.test")).toHaveValue("editor");
    expect(ed.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(ed.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(within(row("inv@example.test")).getByText("Invited")).toBeInTheDocument();
    const gone = within(row("gone@example.test"));
    expect(gone.getByText("Revoked")).toBeInTheDocument();
    expect(gone.queryByRole("button")).toBeNull();
    expect(gone.queryByRole("combobox")).toBeNull();
    expect(screen.getAllByText("2026-10-10 23:00 AEDT").length).toBeGreaterThan(0);
  });

  it("audit log: Melbourne time, names, no network data", async () => {
    render(await UsersPage());
    expect(svc.listAudit).toHaveBeenCalledWith(expect.anything(), 100);
    const log = within(screen.getByRole("region", { name: "Audit log" }));
    expect(log.getByText("user.add")).toBeInTheDocument();
    expect(log.getAllByText("owner@example.test").length).toBeGreaterThan(0);
    expect(log.getAllByText("ed@example.test").length).toBeGreaterThan(0);
    expect(log.getByText("System")).toBeInTheDocument();
    expect(log.getByText("User #77")).toBeInTheDocument();
    expect(log.getByText("User #88")).toBeInTheDocument();
    expect(log.getByText("AU")).toBeInTheDocument();
    expect(log.getByText('{"role":"editor"}')).toBeInTheDocument();
    expect(log.queryByText(/IP|agent/i)).toBeNull();
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

describe("RevokeButton dialog", () => {
  it("opens a modal naming the user and saying they are not emailed", () => {
    render(<RevokeButton userId={2} email="ed@example.test" action={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "Revoke access for ed@example.test? They are not emailed.",
      }),
    ).toBeInTheDocument();
  });

  it("Cancel closes without calling the action", () => {
    const action = vi.fn();
    render(<RevokeButton userId={2} email="ed@example.test" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("Confirm submits the user id and closes on success", async () => {
    const action = vi.fn<(fd: FormData) => Promise<{ ok: true }>>(async () => ({
      ok: true as const,
    }));
    render(<RevokeButton userId={2} email="ed@example.test" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await submit(screen.getByRole("button", { name: "Confirm" }));
    expect(action.mock.calls[0][0].get("userId")).toBe("2");
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
  });

  it("stays open and shows the error when the action refuses", async () => {
    const action = vi.fn<(fd: FormData) => Promise<{ error: string }>>(async () => ({
      error: "owner_protected",
    }));
    render(<RevokeButton userId={1} email="owner@example.test" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await submit(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The Owner cannot be changed here.");
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
  });
});
