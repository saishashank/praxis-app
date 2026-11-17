// @vitest-environment node
// Licence store (M22 E1; D-1430): append-only, the latest row per source is the status, an unknown expert is
// refused by the insert guard, the monthly run is recorded once.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  appendLicence,
  latestLicence,
  latestLicenceOf,
  licenceRunInMonth,
  licenceView,
  recordLicenceRun,
  type LicenceRow,
} from "@/lib/experts/licence/store";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld } from "../uiWorld";

afterAll(cleanupTempDbs);

let main: Client;
beforeEach(async () => {
  main = (await zzWorld()).main;
});

const row = (o: Partial<LicenceRow> = {}): LicenceRow => ({
  expertId: "X-ZZ1",
  sourceKey: "https://zz1.example.test",
  checkedAt: "2030-03-01T00:00:00.000Z",
  termsUrl: null,
  robots: "allows",
  summarisation: "unknown",
  status: "enabled",
  actor: "job",
  note: null,
  ...o,
});
const key = { expertId: "X-ZZ1", sourceKey: "https://zz1.example.test" };

describe("expert_source_licence store", () => {
  it("no row means no status", async () => {
    expect(await latestLicence(main, key)).toBeNull();
  });

  it("the latest row per source wins, whatever the insert order", async () => {
    await appendLicence(
      main,
      row({ checkedAt: "2030-05-01T00:00:00.000Z", status: "no", robots: "disallows" }),
    );
    await appendLicence(main, row({ checkedAt: "2030-03-01T00:00:00.000Z", status: "enabled" }));
    await appendLicence(
      main,
      row({ checkedAt: "2030-04-01T00:00:00.000Z", status: "unchecked", robots: "unreachable" }),
    );
    expect((await latestLicence(main, key))?.status).toBe("no");
    await appendLicence(
      main,
      row({ checkedAt: "2030-06-01T00:00:00.000Z", status: "owner-accepted-risk", actor: "owner" }),
    );
    const l = await latestLicence(main, key);
    expect(l).toMatchObject({ status: "owner-accepted-risk", actor: "owner" });
  });

  it("each source has its own latest row", async () => {
    await appendLicence(main, row({ status: "no", robots: "disallows" }));
    await appendLicence(main, row({ sourceKey: "youtube:zz-handle-1", status: "enabled" }));
    await appendLicence(main, row({ expertId: "X-ZZ2", status: "enabled" }));
    const m = await latestLicenceOf(main, "X-ZZ1");
    expect([...m.keys()].sort()).toEqual(["https://zz1.example.test", "youtube:zz-handle-1"]);
    expect(m.get("https://zz1.example.test")?.status).toBe("no");
    expect((await latestLicence(main, { ...key, expertId: "X-ZZ2" }))?.status).toBe("enabled");
  });

  it("is append-only: no update, no delete", async () => {
    await appendLicence(main, row());
    await expect(main.execute("UPDATE expert_source_licence SET status = 'no'")).rejects.toThrow(
      /append-only/,
    );
    await expect(main.execute("DELETE FROM expert_source_licence")).rejects.toThrow(/append-only/);
  });

  it("refuses an unknown expert, a bad status, a bad actor and a long note", async () => {
    await expect(appendLicence(main, row({ expertId: "X-NOPE" }))).rejects.toThrow(
      /expert must exist/,
    );
    await expect(appendLicence(main, row({ status: "yes" as never }))).rejects.toThrow();
    await expect(appendLicence(main, row({ actor: "bot" as never }))).rejects.toThrow();
    await expect(appendLicence(main, row({ note: "x".repeat(201) }))).rejects.toThrow();
  });

  it("the expert view lists each source with its latest row", async () => {
    await appendLicence(main, row({ status: "enabled" }));
    const v = await licenceView(main, "X-ZZ1");
    expect(v?.map((x) => [x.source.key, x.latest?.status ?? null])).toEqual([
      ["youtube:zz-handle-1", null],
      ["https://zz1.example.test", "enabled"],
    ]);
    expect(await licenceView(main, "X-NOPE")).toBeNull();
  });

  it("records the monthly run once and finds it for the month", async () => {
    expect(await licenceRunInMonth(main, "2030-03-15")).toBe(false);
    await recordLicenceRun(main, "2030-03-02", { checked: 4 }, "2030-03-02T01:00:00.000Z");
    await recordLicenceRun(main, "2030-03-02", { checked: 9 }, "2030-03-02T02:00:00.000Z");
    expect(await licenceRunInMonth(main, "2030-03-15")).toBe(true);
    expect(await licenceRunInMonth(main, "2030-04-01")).toBe(false);
    const r = await main.execute("SELECT counts_json FROM expert_poll_run WHERE kind = 'licence'");
    expect(r.rows).toHaveLength(1);
    expect(JSON.parse(String(r.rows[0]!.counts_json))).toEqual({ checked: 4 });
  });
});
