// UX-116, ROL-102a, ROL-106 (Configuration page)
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
      "How long we keep data",
      "Quotas",
      "Sessions and limits",
      "Backups",
      "Strategy families",
      "Regime and events",
      "Checking results",
      "Replay and compute",
      "Sentinel and email",
      "Learning and knowledge",
      "Other",
      "Recent changes",
    ]);
  });

  it("shows value, default, bounds and spec ref, read-only (D-174)", async () => {
    render(await ConfigPage());
    const retention = screen.getByRole("region", { name: "How long we keep data" });
    const row = within(retention)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-config-key") === "retention_logs_days")!;
    expect(within(row).getByText("Keep application logs for")).toBeInTheDocument();
    expect(within(row).getByText("retention_logs_days")).toBeInTheDocument();
    expect(within(row).getAllByText("30 days")).toHaveLength(2); // current and default
    expect(within(row).getByText("Current value")).toBeInTheDocument();
    expect(within(row).getByText("Default")).toBeInTheDocument();
    expect(within(row).getByText(/whole days, at least 1/)).toBeInTheDocument();
    expect(within(row).getByText(/DAT-142/)).toBeInTheDocument();
    // an unchanged value has no "changed" dot
    expect(row.querySelector("[data-changed]")).toBeNull();
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("no row on the page offers a way to change a value (Owner: just show it)", async () => {
    render(await ConfigPage());
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    // the only form is the search (UXR-028 search, D-174 no editor): one text field, one Search button
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: "Save" })).toHaveLength(0);
    expect(screen.queryByText("Fixed by the spec")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(action.updateConfigAction).not.toHaveBeenCalled();
    expect(Object.values(CONFIG_KEYS).length).toBeGreaterThan(3);
  });

  it("a stored value shows the changed dot and when it changed", async () => {
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
    const row = document.querySelector('[data-config-key="token_warning_days"]') as HTMLElement;
    expect(within(row).getByText("21, 7 days")).toBeInTheDocument();
    expect(within(row).getByText("Changed 2026-10-10 23:00 AEDT (version 12)")).toBeInTheDocument();
    expect(row.querySelector("[data-changed]")).toHaveTextContent("Changed");
    expect(document.querySelectorAll("[data-changed]")).toHaveLength(1);
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

  it("search filters by key or plain label and says so when nothing matches", async () => {
    render(await ConfigPage({ searchParams: Promise.resolve({ q: "RETENTION" }) }));
    const items = screen
      .getAllByRole("listitem")
      .filter((li) => li.hasAttribute("data-config-key"));
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) {
      expect(li.getAttribute("data-config-key")! + li.textContent!.toLowerCase()).toMatch(
        /retention/,
      );
    }
    expect(screen.getByRole("searchbox")).toHaveValue("retention");
    cleanup();
    render(await ConfigPage({ searchParams: Promise.resolve({ q: "zzz-no-such-setting" }) }));
    expect(screen.getByText("No setting matches that search")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-config-key]")).toHaveLength(0);
  });

  it("states its purpose in one line (UXR-001)", async () => {
    render(await ConfigPage());
    expect(screen.getByText(/Every tunable value with its default/)).toBeInTheDocument();
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
