import { describe, expect, it } from "vitest";
import {
  FAMILIES,
  haltProxy,
  isOff,
  mayFetch,
  parseMode,
  planForStatuses,
  type Family,
  type SourceMode,
  type SourceStatuses,
} from "@/lib/data/sources/status";

const all = (m: SourceMode): SourceStatuses => ({ asx: m, yahoo: m, asic: m });
const mix = (p: Partial<SourceStatuses>): SourceStatuses => ({ ...all("on"), ...p });
const fam = (...fs: Family[]) => fs;

describe("DAT-127 source-off matrix", () => {
  it("all sources on: nothing is restricted", () => {
    const p = planForStatuses(all("on"));
    expect(p.fetch).toEqual({ asx: true, yahoo: true, asic: true });
    expect(p.newAnnouncementEvents).toBe(true);
    expect(p.haltProxyOnly).toBe(false);
    expect(p.newBarsExpected).toBe(true);
    expect(p.markAtLastPriceFlagged).toBe(false);
    expect(p.exitsProcessed).toBe(true);
    expect(FAMILIES.every((f) => p.entries[f] === "normal")).toBe(true);
    expect(p.offFeeds).toEqual([]);
    expect(p.degraded).toEqual([]);
  });

  it("ASX off: no new events, halt proxy, F2/F3/F5/F6 no entries, F1/F4 proxy, exits continue", () => {
    const p = planForStatuses(mix({ asx: "off" }));
    expect(p.fetch.asx).toBe(false);
    expect(p.newAnnouncementEvents).toBe(false);
    expect(p.haltProxyOnly).toBe(true);
    for (const f of fam("F2", "F3", "F5", "F6")) expect(p.entries[f]).toBe("no_new_entries");
    for (const f of fam("F1", "F4")) expect(p.entries[f]).toBe("halt_proxy");
    expect(p.exitsProcessed).toBe(true);
    expect(p.newBarsExpected).toBe(true);
    expect(p.offFeeds).toEqual(["asx"]);
  });

  it("Yahoo off: no bars, all entries blocked, positions marked at last price, exits paused", () => {
    const p = planForStatuses(mix({ yahoo: "off" }));
    expect(p.fetch.yahoo).toBe(false);
    expect(p.newBarsExpected).toBe(false);
    expect(FAMILIES.every((f) => p.entries[f] === "no_new_entries")).toBe(true);
    expect(p.markAtLastPriceFlagged).toBe(true);
    expect(p.exitsProcessed).toBe(false);
    expect(p.newAnnouncementEvents).toBe(true);
    expect(p.offFeeds).toEqual(["yahoo"]);
  });

  it("ASIC off: only F6 changes, to no-short-interest", () => {
    const p = planForStatuses(mix({ asic: "off" }));
    expect(p.fetch.asic).toBe(false);
    expect(p.entries.F6).toBe("no_short_interest");
    for (const f of fam("F1", "F2", "F3", "F4", "F5")) expect(p.entries[f]).toBe("normal");
    expect(p.exitsProcessed).toBe(true);
    expect(p.offFeeds).toEqual(["asic"]);
  });

  it("ASX and ASIC off: F6 is blocked (the stricter rule wins)", () => {
    expect(planForStatuses(mix({ asx: "off", asic: "off" })).entries.F6).toBe("no_new_entries");
  });

  it("Yahoo off overrides the ASX-off halt proxy", () => {
    const p = planForStatuses(mix({ asx: "off", yahoo: "off" }));
    expect(p.entries.F1).toBe("no_new_entries");
    expect(p.entries.F4).toBe("no_new_entries");
  });

  it("everything off", () => {
    const p = planForStatuses(all("off"));
    expect(p.fetch).toEqual({ asx: false, yahoo: false, asic: false });
    expect(p.offFeeds).toEqual(["asx", "yahoo", "asic"]);
    expect(p.exitsProcessed).toBe(false);
  });

  it("tripped behaves exactly like off", () => {
    expect(planForStatuses(all("tripped"))).toEqual(planForStatuses(all("off")));
  });

  it("degraded keeps fetching and applies no off-consequence, but is reported", () => {
    const p = planForStatuses(all("degraded"));
    expect(p.fetch).toEqual({ asx: true, yahoo: true, asic: true });
    expect(p.newAnnouncementEvents).toBe(true);
    expect(p.exitsProcessed).toBe(true);
    expect(FAMILIES.every((f) => p.entries[f] === "normal")).toBe(true);
    expect(p.degraded).toEqual(["asx", "yahoo", "asic"]);
    expect(p.offFeeds).toEqual([]);
  });
});

describe("helpers", () => {
  it("mayFetch / isOff (DAT-123)", () => {
    expect(mayFetch("on")).toBe(true);
    expect(mayFetch("degraded")).toBe(true);
    expect(mayFetch("off")).toBe(false);
    expect(mayFetch("tripped")).toBe(false);
    expect(isOff("tripped")).toBe(true);
  });

  it("halt proxy = zero volume or no price in the last session (DAT-127 s13)", () => {
    expect(haltProxy(null)).toBe(true);
    expect(haltProxy({ volume: 0, close: 1 })).toBe(true);
    expect(haltProxy({ volume: 10, close: null })).toBe(true);
    expect(haltProxy({ volume: null, close: 1 })).toBe(true);
    expect(haltProxy({ volume: 10, close: 1 })).toBe(false);
  });

  it("parseMode accepts only known modes", () => {
    expect(parseMode("on")).toBe("on");
    expect(parseMode("tripped")).toBe("tripped");
    expect(parseMode("degraded")).toBe("degraded");
    expect(parseMode("off")).toBe("off");
    expect(parseMode("ON")).toBeNull();
    expect(parseMode(1)).toBeNull();
  });
});
