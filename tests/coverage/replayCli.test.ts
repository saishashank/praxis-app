// @vitest-environment node
// M8 T3 coverage (TST-121): the refusal and failure paths of the replay command line (usage errors,
// bad arguments, missing database or snapshot source, a thrown driver error that must not be echoed)
// and the local null / injected checks. No real database: a stub client is enough for these paths.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { nullRunsMain, replayMain } from "@/lib/replay/cli";

const params = defaultAgentParams();

function stubDb(execute: () => Promise<unknown>): Client {
  return { execute, batch: execute, close: () => undefined } as unknown as Client;
}

const collect = () => {
  const lines: string[] = [];
  return { lines, out: (s: string) => void lines.push(s) };
};

afterEach(() => vi.restoreAllMocks());

describe("replayMain refusals", () => {
  it("usage: no mode or an unknown mode exits 2 and prints through the default writer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await replayMain([], {})).toBe(2);
    expect(await replayMain(["--mode", "sideways"], {})).toBe(2);
    expect(log.mock.calls[0]![0]).toMatch(/^replay: failed \(usage: --mode /);
  });

  it.each([
    ["a date that is not a date", ["--mode", "light", "--date", "2029-13-45"]],
    ["a since that is not a date", ["--mode", "light", "--date", "2029-06-29", "--since", "soon"]],
    ["runs of zero", ["--mode", "null", "--date", "2029-06-29", "--runs", "0"]],
    ["runs that are not whole", ["--mode", "null", "--date", "2029-06-29", "--runs", "2.5"]],
    ["a negative budget", ["--mode", "light", "--date", "2029-06-29", "--budget-minutes", "-3"]],
  ])("bad argument: %s exits 2", async (_n, argv) => {
    const c = collect();
    expect(await replayMain(argv, {}, { out: c.out })).toBe(2);
    expect(c.lines).toEqual(["replay: failed (bad argument)"]);
  });

  it("an unset date defaults to today's market date and then the database check decides", async () => {
    const c = collect();
    expect(await replayMain(["--mode", "light"], {}, { out: c.out, nowMs: () => 1_800_000_000_000 })).toBe(1);
    expect(c.lines).toEqual(["replay: failed (database not configured)"]);
  });

  it("database not configured: no URL, or a remote URL without a token", async () => {
    const c = collect();
    const argv = ["--mode", "light", "--date", "2029-06-29"];
    expect(await replayMain(argv, { TURSO_MAIN_URL: "  " }, { out: c.out })).toBe(1);
    expect(await replayMain(argv, { TURSO_MAIN_URL: "libsql://x.invalid" }, { out: c.out })).toBe(1);
    expect(c.lines).toEqual([
      "replay: failed (database not configured)",
      "replay: failed (database not configured)",
    ]);
  });

  it("a file URL needs no token; without a snapshot source the run stops with exit 1", async () => {
    const c = collect();
    let opened: [string, string | undefined] | null = null;
    const code = await replayMain(
      ["--mode", "light", "--date", "2029-06-29"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        out: c.out,
        params,
        openDb: (u, t) => {
          opened = [u, t];
          return stubDb(async () => ({ rows: [] }));
        },
      },
    );
    expect(code).toBe(1);
    expect(opened).toEqual(["file:x.db", undefined]);
    expect(c.lines).toEqual(["replay: failed (no snapshot source)"]);
  });

  it("a token is passed on to the client", async () => {
    let opened: [string, string | undefined] | null = null;
    await replayMain(
      ["--mode", "light", "--date", "2029-06-29"],
      { TURSO_MAIN_URL: "libsql://x.invalid", TURSO_MAIN_TOKEN: "tok" },
      {
        out: () => undefined,
        params,
        openDb: (u, t) => {
          opened = [u, t];
          return stubDb(async () => ({ rows: [] }));
        },
      },
    );
    expect(opened).toEqual(["libsql://x.invalid", "tok"]);
  });

  it("default params are used when loading them fails; a driver error is reported by name only", async () => {
    const c = collect();
    const secret = "libsql://secret-host.invalid";
    const code = await replayMain(
      ["--mode", "full", "--date", "2029-06-29", "--runs", "3", "--budget-minutes", "5"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        out: c.out,
        openDb: () =>
          stubDb(async () => {
            throw new TypeError(secret);
          }),
        prepareSnapshot: async () => {
          throw new RangeError(secret);
        },
      },
    );
    expect(code).toBe(1);
    // D-188: the stage and our code locations, never the message
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatch(/^replay full: failed \(RangeError\) stage=snapshot at=\S+$/);
    expect(c.lines.join()).not.toContain("secret-host");
  });

  it("a thrown non-Error value is reported as Error", async () => {
    const c = collect();
    const code = await replayMain(
      ["--mode", "full", "--date", "2029-06-29"],
      { TURSO_MAIN_URL: "file:x.db", COMMIT_SHA: "c".repeat(40) },
      {
        out: c.out,
        params,
        openDb: () => stubDb(async () => ({ rows: [] })),
        prepareSnapshot: async () => {
          throw "boom";
        },
      },
    );
    expect(code).toBe(1);
    expect(c.lines).toEqual(["replay full: failed (Error) stage=snapshot"]);
  });

  it("the snapshot range is the event back-fill window ending on the run date", async () => {
    let range: { from: string; to: string } | null = null;
    await replayMain(
      ["--mode", "full", "--date", "2029-06-29"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        out: () => undefined,
        params,
        openDb: () => stubDb(async () => ({ rows: [] })),
        prepareSnapshot: async (r) => {
          range = r;
          throw new Error("stop");
        },
      },
    );
    expect(range!.to).toBe("2029-06-29");
    expect(range!.from).toBe(`${2029 - (params.replay.eventBackfillYears + 1)}-06-29`);
  });

  it("injected and synthetic null runs need no snapshot source", async () => {
    const c = collect();
    const deps = {
      out: c.out,
      params,
      openDb: () =>
        stubDb(async () => {
          throw new Error("stop at the first database use");
        }),
    };
    for (const argv of [
      ["--mode", "injected", "--date", "2029-06-29", "--runs", "1"],
      ["--mode", "null", "--synthetic", "--date", "2029-06-29", "--runs", "1"],
    ]) {
      const code = await replayMain(argv, { TURSO_MAIN_URL: "file:x.db" }, deps);
      expect(c.lines.at(-1)).not.toBe("replay: failed (no snapshot source)");
      expect([0, 1]).toContain(code);
    }
  }, 120_000);
});

describe("replayMain recording (D-198)", () => {
  it("records over a fresh connection: the one used before the hours of computing may be gone", async () => {
    const c = collect();
    const opened: string[] = [];
    let closed = 0;
    const deps = {
      out: c.out,
      params,
      openDb: () => {
        const n = opened.push("db");
        return {
          execute: async () => {
            if (n === 1) throw new TypeError("stale");
            const e = new TypeError("fetch failed");
            e.cause = { code: "ECONNRESET" };
            throw e;
          },
          batch: async () => [],
          close: () => void (closed += 1),
        } as unknown as Client;
      },
    };
    const code = await replayMain(["--mode", "injected", "--date", "2029-06-29", "--runs", "1"], { TURSO_MAIN_URL: "file:x.db" }, deps);
    expect(code).toBe(1);
    expect(opened).toHaveLength(2);
    expect(closed).toBe(2);
    expect(c.lines.at(-1)).toMatch(/^replay injected: failed \(TypeError\) stage=record at=\S+ cause=ECONNRESET$/);
  }, 120_000);
});

describe("nullRunsMain", () => {
  it("usage and bad arguments exit 2", async () => {
    const c = collect();
    expect(await nullRunsMain([], { out: c.out })).toBe(2);
    expect(await nullRunsMain(["--kind", "other"], { out: c.out })).toBe(2);
    expect(await nullRunsMain(["--kind", "null", "--runs", "0"], { out: c.out })).toBe(2);
    expect(await nullRunsMain(["--kind", "injected", "--runs", "x"], { out: c.out })).toBe(2);
    expect(c.lines[0]).toMatch(/^nullRuns: failed \(usage:/);
    expect(c.lines[2]).toBe("nullRuns: failed (bad argument)");
  });

  it("the default writer is console.log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await nullRunsMain([])).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("null: prints the size report as aggregates only", async () => {
    const c = collect();
    let t = 0;
    const code = await nullRunsMain(["--kind", "null", "--runs", "20"], {
      out: c.out,
      nowMs: () => (t += 30_000),
    });
    expect([0, 1]).toContain(code);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatch(/^nullRuns null: n=20 rejections .* ks_p=\d\.\d{4} extrapolated .* pass=(true|false) minutes=\d/);
  }, 120_000);

  it("injected: prints the detection rate; a snapshot flag without a reader falls back to synthetic rows", async () => {
    const c = collect();
    const code = await nullRunsMain(["--kind", "injected", "--runs", "3", "--snapshot", "x.jsonl.gz"], {
      out: c.out,
    });
    expect([0, 1]).toContain(code);
    expect(c.lines[0]).toMatch(/^nullRuns injected: detection_rate=/);
  }, 120_000);
});
