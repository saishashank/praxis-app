// M7 T9: the generic error pages (UX-122) and the error hook that writes the digest to app_log.
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";
import { logRequestError, requestErrorMessage } from "@/lib/ui/errorLog";
import { onRequestError } from "@/instrumentation";

const exec = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));

const secret = Object.assign(new Error("SECRET /market/BHP failed: token=abc123"), {
  digest: "1234567890",
});

describe("error.tsx", () => {
  it("shows the correlation id, never the message, and offers retry and home", () => {
    const reset = vi.fn();
    render(<ErrorPage error={secret} reset={reset} />);
    expect(screen.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeVisible();
    expect(screen.getByText("1234567890")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/SECRET|BHP|abc123/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
  it("says so when there is no digest", () => {
    render(<ErrorPage error={new Error("x")} reset={() => {}} />);
    expect(screen.getByText("not available")).toBeInTheDocument();
  });
});

describe("global-error.tsx", () => {
  it("brings its own html and body, shows only the digest", () => {
    const html = renderToString(<GlobalError error={secret} reset={() => {}} />);
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain("<body");
    expect(html).toContain("1234567890");
    expect(html).not.toMatch(/SECRET|BHP|abc123/);
    expect(html).toContain("<h1");
  });
});

describe("not-found.tsx", () => {
  it("is plain and links home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
  });
});

describe("requestErrorMessage / logRequestError", () => {
  const ctx = { routePath: "/market/[code]", routeType: "render", routerKind: "App Router" };
  it("has digest, class, route template and method; no message, no real path", () => {
    const msg = requestErrorMessage(secret, { path: "/market/BHP", method: "GET" }, ctx);
    expect(msg).toBe(
      "request_error digest=1234567890 class=Error route=/market/[code] method=GET type=render",
    );
    expect(msg).not.toMatch(/SECRET|BHP|abc123/);
  });
  it("replaces anything odd with unknown and stays within 500 characters", () => {
    const e = Object.assign(new Error("x"), { digest: "bad digest;DROP", name: "Bad Name" });
    const msg = requestErrorMessage(e, { method: "get" }, { routePath: "x".repeat(500) });
    expect(msg).toBe(
      "request_error digest=unknown class=unknown route=unknown method=unknown type=unknown",
    );
    expect(requestErrorMessage(null, {}, {}).length).toBeLessThanOrEqual(500);
  });
  it("inserts one error row into app_log", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    await logRequestError(
      { execute } as never,
      secret,
      { method: "POST" },
      ctx,
      new Date("2026-10-20T01:02:03Z"),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const arg = (execute.mock.calls[0] as unknown[])[0] as { sql: string; args: unknown[] };
    expect(arg.sql).toContain("INSERT INTO app_log");
    expect(arg.sql).toContain("'error'");
    expect(arg.args[0]).toBe("2026-10-20T01:02:03.000Z");
    expect(arg.args[1]).toBe("web");
    expect(String(arg.args[2])).toContain("digest=1234567890");
  });
  it("never throws when the database fails", async () => {
    const execute = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(logRequestError({ execute } as never, secret, {}, {})).resolves.toBeUndefined();
  });
});

describe("instrumentation onRequestError", () => {
  beforeEach(() => {
    vi.resetModules();
    exec.mockClear();
    vi.doMock("@/lib/db/client", () => ({ mainDb: () => ({ execute: exec }) }));
  });
  afterEach(() => {
    vi.doUnmock("@/lib/db/client");
    vi.unstubAllEnvs();
  });

  it("writes the digest to app_log on the Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const mod = await import("@/instrumentation");
    await mod.onRequestError(secret, { path: "/x", method: "GET" }, { routePath: "/x" });
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("does nothing on the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const mod = await import("@/instrumentation");
    await mod.onRequestError(secret, {}, {});
    expect(exec).not.toHaveBeenCalled();
  });
  it("swallows a missing database configuration", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.doMock("@/lib/db/client", () => ({
      mainDb: () => {
        throw new Error("database not configured");
      },
    }));
    const mod = await import("@/instrumentation");
    await expect(mod.onRequestError(secret, {}, {})).resolves.toBeUndefined();
  });
  it("exports the hook (Next looks it up by name)", () => {
    expect(typeof onRequestError).toBe("function");
  });
});
