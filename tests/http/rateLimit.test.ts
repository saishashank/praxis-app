// @vitest-environment node
import type { Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/http/rateLimit";
import { freshDb } from "../db/helpers";

const T = 1_700_000_040; // a multiple of 60

describe("rateLimit", () => {
  it("counts up and allows exactly `limit` calls per window", async () => {
    const db = await freshDb("auth");
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await rateLimit(db, "signin:1.1.1.1", 10, 60, T + i));
    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[9].count).toBe(10);
    expect(results[10]).toEqual({ allowed: false, count: 11 });
  });

  it("buckets are independent", async () => {
    const db = await freshDb("auth");
    await rateLimit(db, "a", 1, 60, T);
    expect((await rateLimit(db, "a", 1, 60, T)).allowed).toBe(false);
    expect((await rateLimit(db, "b", 1, 60, T)).allowed).toBe(true);
  });

  it("a new window starts at 1 again", async () => {
    const db = await freshDb("auth");
    await rateLimit(db, "a", 1, 60, T);
    expect((await rateLimit(db, "a", 1, 60, T + 59)).allowed).toBe(false);
    expect(await rateLimit(db, "a", 1, 60, T + 60)).toEqual({ allowed: true, count: 1 });
  });

  it("drops rows older than an hour when a new window opens", async () => {
    const db = await freshDb("auth");
    await rateLimit(db, "old", 5, 60, T);
    await rateLimit(db, "new", 5, 60, T + 3601);
    const r = await db.execute("SELECT bucket FROM rate_limit ORDER BY bucket");
    expect(r.rows.map((x) => x.bucket)).toEqual(["new"]);
  });

  it("defaults nowSec to the clock", async () => {
    const db = await freshDb("auth");
    expect((await rateLimit(db, "c", 1, 60)).allowed).toBe(true);
  });

  it("propagates DB errors (caller answers 503)", async () => {
    const broken = {
      execute: async () => {
        throw new Error("down");
      },
    } as unknown as Client;
    await expect(rateLimit(broken, "x", 1, 60, T)).rejects.toThrow("down");
  });
});
