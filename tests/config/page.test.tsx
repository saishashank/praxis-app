// UX-116, ROL-102a, ROL-106 (Configuration page)
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const svc = vi.hoisted(() => ({ listConfig: vi.fn(), listConfigHistory: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/config/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/config/admin")>()),
  ...svc,
}));
const action = vi.hoisted(() => ({
  updateConfigAction: vi.fn<(fd: FormData) => Promise<unknown>>(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/config/actions", () => action);

import ConfigPage from "@/app/(app)/config/page";
import { ConfigForm } from "@/app/(app)/config/ConfigForm";
import type { ConfigRow } from "@/lib/config/admin";
import { CONFIG_KEYS, CONFIG_META, type ConfigKey } from "@/lib/config/keys";

const T = "2026-10-10T12:00:00.000Z";

function rows(over: Partial<Record<ConfigKey, Partial<ConfigRow>>> = {}): ConfigRow[] {
  return (Object.keys(CONFIG_KEYS) as ConfigKey[]).map((key) => {
    const def = CONFIG_KEYS[key];
    const m = CONFIG_META[key];
    return {
      key,
      label: m.label,
      area: m.area,
      unit: def.unit,
      default: def.default,
      bounds: m.bounds,
      editable: def.editable,
      ref: def.ref,
      input: m.input,
      value: def.default,
      source: "default",
      lastChange: null,
      ...over[key],
    } as ConfigRow;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: 1, email: "owner@example.test", name: null, role: "owner" });
  svc.listConfig.mockResolvedValue(rows());
  svc.listConfigHistory.mockResolvedValue([]);
});

describe("configuration page", () => {
  it("requires the admin action on /config", async () => {
    render(await ConfigPage());
    expect(requireUser).toHaveBeenCalledWith("admin", "/config");
    expect(screen.getByRole("heading", { level: 1, name: "Configuration" })).toBeInTheDocument();
  });

  it.each(["editor", "viewer"])("is forbidden for a %s: no data is read", async (role) => {
    requireUser.mockImplementationOnce(async () => {
      if (role) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    });
    await expect(ConfigPage()).rejects.toThrow(/403/);
    expect(svc.listConfig).not.toHaveBeenCalled();
    expect(svc.listConfigHistory).not.toHaveBeenCalled();
  });

  it("groups keys by area in order", async () => {
    render(await ConfigPage());
    const heads = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(heads).toEqual([
      "Retention",
      "Quotas",
      "Sessions & limits",
      "Backups",
      "Other",
      "Recent changes",
    ]);
  });

  it("shows value, default, bounds and spec ref; editable keys have value, reason and Save", async () => {
    render(await ConfigPage());
    const retention = screen.getByRole("region", { name: "Retention" });
    const row = within(retention).getByRole("row", { name: /retention_logs_days/ });
    expect(within(row).getByText("Keep application logs for")).toBeInTheDocument();
    expect(within(row).getAllByText("30 days")).toHaveLength(2); // current and default
    expect(within(row).getByText("whole days, at least 1")).toBeInTheDocument();
    expect(within(row).getByText("DAT-142")).toBeInTheDocument();
    expect(within(row).getByText("Default")).toBeInTheDocument();
    expect(within(row).getByLabelText("New value for Keep application logs for")).toHaveValue("30");
    expect(
      within(row).getByLabelText("Reason for changing Keep application logs for"),
    ).toBeRequired();
    expect(within(row).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("fixed keys show 'Fixed by the spec' and no form", async () => {
    render(await ConfigPage());
    const row = screen.getByRole("row", { name: /hmac_max_age_s/ });
    expect(within(row).getByText("Fixed by the spec")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(screen.getAllByText("Fixed by the spec")).toHaveLength(2);
  });

  it("a stored value shows when it changed and prefills the edit field", async () => {
    svc.listConfig.mockResolvedValue(
      rows({
        token_warning_days: {
          value: [21, 7],
          source: "stored",
          lastChange: { at: T, versionId: 12 },
        },
      }),
    );
    render(await ConfigPage());
    const row = screen.getByRole("row", { name: /token_warning_days/ });
    expect(within(row).getByText("21, 7 days")).toBeInTheDocument();
    expect(within(row).getByText("Changed 2026-10-10 23:00 AEDT (version 12)")).toBeInTheDocument();
    expect(within(row).getByLabelText(/New value for/)).toHaveValue("21, 7");
  });

  it("history lists at, key, before -> after and reason", async () => {
    svc.listConfigHistory.mockResolvedValue([
      {
        id: 2,
        at: T,
        key: "retention_logs_days",
        scope: "global",
        before: 30,
        after: 21,
        reason: "tidy",
      },
      { id: 1, at: T, key: "removed_key", scope: "global", before: null, after: 1, reason: null },
    ]);
    render(await ConfigPage());
    const hist = screen.getByRole("region", { name: "Recent changes" });
    const r1 = within(hist).getByRole("row", { name: /retention_logs_days/ });
    expect(within(r1).getByText(/30 days → 21 days/)).toBeInTheDocument();
    expect(within(r1).getByText("tidy")).toBeInTheDocument();
    expect(svc.listConfigHistory).toHaveBeenCalledWith(expect.anything(), 20);
    expect(within(hist).getByRole("row", { name: /removed_key/ })).toBeInTheDocument();
    expect(screen.queryByText("No changes yet.")).toBeNull();
  });

  it("empty history and the ROL-106 footer", async () => {
    render(await ConfigPage());
    expect(screen.getByText("No changes yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Simulation for personal information only — not financial advice"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("hides an area with no keys", async () => {
    svc.listConfig.mockResolvedValue(rows().filter((r) => r.area !== "Backups"));
    render(await ConfigPage());
    expect(screen.queryByRole("heading", { name: "Backups" })).toBeNull();
  });
});

describe("ConfigForm", () => {
  const submit = async (el: HTMLElement) => {
    await act(async () => {
      fireEvent.submit(el.closest("form")!);
    });
  };

  it("submits the form data, then shows Saved", async () => {
    render(await ConfigPage());
    const row = screen.getByRole("row", { name: /retention_logs_days/ });
    fireEvent.change(within(row).getByLabelText(/New value for/), { target: { value: "21" } });
    fireEvent.change(within(row).getByLabelText(/Reason for/), { target: { value: "tidy" } });
    await submit(within(row).getByRole("button", { name: "Save" }));
    const fd = action.updateConfigAction.mock.calls[0][0];
    expect(fd.get("key")).toBe("retention_logs_days");
    expect(fd.get("value")).toBe("21");
    expect(fd.get("reason")).toBe("tidy");
    expect(within(row).getByRole("status")).toHaveTextContent("Saved.");
  });

  it("shows the message for an error, else the text for the code", async () => {
    render(
      <ConfigForm action={async () => ({ error: "invalid", message: "Value must be whole." })}>
        <button type="submit">Go</button>
      </ConfigForm>,
    );
    await submit(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Value must be whole.");
  });

  it("falls back to the code text without a message", async () => {
    render(
      <ConfigForm action={async () => ({ error: "unavailable" })}>
        <button type="submit">Go</button>
      </ConfigForm>,
    );
    await submit(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });
});
