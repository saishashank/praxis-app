// M18 OPS-107 / D-965 (AT-84): the host guard in `recorded` mode refuses every non-loopback host, in
// fetch and in net connects, counts the refusals and writes a marker; staging behaviour is unchanged.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlockedHostError,
  assertAllowedRequest,
  connectHost,
  guardFetch,
  installHostGuard,
  installNetGuard,
  isLoopbackHost,
  parseNetLog,
  recordRefusal,
  writeGuardMarker,
} from "@/lib/data/recorded/hostGuard.mjs";

const dirs: string[] = [];
function logFile(): string {
  const d = mkdtempSync(path.join(tmpdir(), "praxis-netlog-"));
  dirs.push(d);
  return path.join(d, "net.log");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const recorded = (log?: string, label = "app") => ({
  PRAXIS_ENV: "recorded",
  ...(log ? { PRAXIS_NET_LOG: log, PRAXIS_NET_LABEL: label } : {}),
});

describe("recorded mode refuses every host except loopback (D-965)", () => {
  it("refuses example.com and allows 127.0.0.1, localhost and ::1", () => {
    const env = recorded();
    expect(() => assertAllowedRequest("https://example.com/x", env)).toThrow(BlockedHostError);
    expect(() => assertAllowedRequest("https://query1.finance.yahoo.com/v8", env)).toThrow(
      BlockedHostError,
    );
    expect(() => assertAllowedRequest("http://127.0.0.1:3100/api/health", env)).not.toThrow();
    expect(() => assertAllowedRequest("http://localhost:3100/", env)).not.toThrow();
    expect(() => assertAllowedRequest("http://[::1]:3100/", env)).not.toThrow();
    expect(() => assertAllowedRequest(new URL("http://127.0.0.1/"), env)).not.toThrow();
    expect(() => assertAllowedRequest({ url: "http://127.0.0.1/" }, env)).not.toThrow();
  });

  it("refuses look-alikes and an unparseable target", () => {
    const env = recorded();
    for (const t of [
      "http://127.0.0.1.example.com/",
      "http://localhost.example.com/",
      "http://10.0.0.1/",
      "http://0.0.0.0/",
      "not a url",
      "",
    ]) {
      expect(() => assertAllowedRequest(t, env), t).toThrow(BlockedHostError);
    }
  });

  it("isLoopbackHost: the whole 127/8 range, no look-alikes", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST.", "::1", "[::1]"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["128.0.0.1", "127.0.0", "mylocalhost", "example.com", "::2", ""]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it("guardFetch never calls the underlying fetch for a refused host, and counts the refusal", async () => {
    const log = logFile();
    let calls = 0;
    const g = guardFetch(
      (async () => {
        calls += 1;
        return new Response("ok");
      }) as typeof fetch,
      recorded(log, "worker-sim"),
    );
    await expect(g("https://example.com/a")).rejects.toBeInstanceOf(BlockedHostError);
    expect(calls).toBe(0);
    expect((await g("http://127.0.0.1:3100/")).status).toBe(200);
    expect(calls).toBe(1);
    expect(parseNetLog(readFileSync(log, "utf8")).refused).toBe(1);
  });

  it("the error and the log never carry the host, URL or path (SEC-110)", async () => {
    const log = logFile();
    const g = guardFetch((async () => new Response("ok")) as typeof fetch, recorded(log));
    let message = "";
    await g("https://secret-host.example.com/path?token=abc").catch((e: Error) => {
      message = e.message;
    });
    const text = readFileSync(log, "utf8");
    for (const s of [message, text]) {
      expect(s).not.toMatch(/secret-host|example\.com|token|https?:/);
    }
    expect(text).toBe("refused app\n");
  });

  it("installHostGuard replaces fetch in a target and undo restores it", async () => {
    const original = (async () => new Response("ok")) as typeof fetch;
    const target = { fetch: original };
    const undo = installHostGuard(recorded(), target);
    expect(target.fetch).not.toBe(original);
    await expect(target.fetch("https://example.com")).rejects.toBeInstanceOf(BlockedHostError);
    undo();
    expect(target.fetch).toBe(original);
  });
});

describe("net guard: a non-loopback TCP connect is refused whatever library makes it", () => {
  class FakeSocket {
    connected: unknown[] | null = null;
    destroyed: unknown = null;
    connect(...args: unknown[]) {
      this.connected = args;
      return this;
    }
    destroy(err: unknown) {
      this.destroyed = err;
    }
  }

  it("connectHost reads the three connect signatures", () => {
    expect(connectHost([{ host: "example.com", port: 443 }])).toBe("example.com");
    expect(connectHost([{ port: 3100 }])).toBeNull();
    expect(connectHost([{ path: "/tmp/x.sock" }])).toBeNull();
    expect(connectHost([443, "example.com"])).toBe("example.com");
    expect(connectHost(["443", "example.com"])).toBe("example.com");
    expect(connectHost([3100])).toBeNull();
    expect(connectHost(["/tmp/x.sock"])).toBeNull();
    // Node's net.connect() passes Socket.connect one normalized array [options, callback]
    expect(connectHost([[{ host: "example.com", port: 443 }, null]])).toBe("example.com");
    expect(connectHost([[{ port: 3100 }, null]])).toBeNull();
  });

  it("refuses, counts and destroys a connect to another host; lets loopback and sockets through", async () => {
    const log = logFile();
    const net = { Socket: FakeSocket };
    const undo = installNetGuard(recorded(log, "orchestrator"), net);
    const s = new FakeSocket();
    s.connect({ host: "example.com", port: 443 });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.connected).toBeNull();
    expect(s.destroyed).toBeInstanceOf(BlockedHostError);
    expect(parseNetLog(readFileSync(log, "utf8")).refused).toBe(1);
    for (const args of [
      [{ host: "127.0.0.1", port: 3100 }],
      [3100, "localhost"],
      [{ port: 3100 }],
      [{ path: "/tmp/x.sock" }],
    ]) {
      const ok = new FakeSocket();
      ok.connect(...args);
      expect(ok.connected).toEqual(args);
    }
    expect(parseNetLog(readFileSync(log, "utf8")).refused).toBe(1);
    undo();
    const after = new FakeSocket();
    after.connect({ host: "example.com", port: 443 });
    expect(after.connected).not.toBeNull();
  });

  it("is a no-op outside recorded mode (staging and production)", () => {
    for (const env of [{ PRAXIS_ENV: "staging" }, { PRAXIS_ENV: "production" }, {}]) {
      const original = FakeSocket.prototype.connect;
      const undo = installNetGuard(env, { Socket: FakeSocket });
      expect(FakeSocket.prototype.connect).toBe(original);
      undo();
    }
  });
});

describe("the log: markers and refusals", () => {
  it("writeGuardMarker and recordRefusal append fixed lines; parseNetLog counts them", () => {
    const log = logFile();
    const env = recorded(log, "app");
    writeGuardMarker(env);
    writeGuardMarker({ ...env, PRAXIS_NET_LABEL: "batch1" });
    recordRefusal(env);
    expect(parseNetLog(readFileSync(log, "utf8"))).toEqual({
      refused: 1,
      markers: ["app", "batch1"],
    });
  });

  it("an odd label is written as unknown, and no log file means nothing is written", () => {
    const log = logFile();
    writeGuardMarker({ ...recorded(log), PRAXIS_NET_LABEL: "a b/../c" });
    expect(readFileSync(log, "utf8")).toBe("guard-installed unknown\n");
    expect(() => writeGuardMarker({ PRAXIS_ENV: "recorded" })).not.toThrow();
  });
});

describe("staging and production are unchanged", () => {
  it("staging still blocks only ASX and Yahoo (and allows other hosts)", () => {
    const env = { PRAXIS_ENV: "staging" };
    expect(() => assertAllowedRequest("https://www.asx.com.au/x", env)).toThrow(BlockedHostError);
    expect(() => assertAllowedRequest("https://example.com/x", env)).not.toThrow();
  });

  it("production has no guard", () => {
    expect(() => assertAllowedRequest("https://query1.finance.yahoo.com", {})).not.toThrow();
    expect(() =>
      assertAllowedRequest("https://example.com", { PRAXIS_ENV: "production" }),
    ).not.toThrow();
  });
});
