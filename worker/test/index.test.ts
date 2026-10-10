import { describe, expect, it, vi } from "vitest";
import worker, { heartbeat } from "../src/index";

describe("heartbeat", () => {
  it("returns a heartbeat record", () => {
    expect(heartbeat(Date.UTC(2026, 9, 9, 12, 0, 0), "staging")).toEqual({
      kind: "heartbeat",
      at: "2026-10-09T12:00:00.000Z",
      env: "staging",
    });
  });
});

describe("worker handlers", () => {
  it("fetch returns 404 Not found", async () => {
    const res = await worker.fetch();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("scheduled logs the heartbeat as JSON", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled({ scheduledTime: 0 } as ScheduledController, {
      PRAXIS_ENV: "production",
    });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      kind: "heartbeat",
      at: "1970-01-01T00:00:00.000Z",
      env: "production",
    });
    log.mockRestore();
  });
});
