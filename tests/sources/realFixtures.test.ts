// @vitest-environment node
// Fixture-backed tests (TST-105). They run only when PRAXIS_FIXTURES_DIR points at a checkout of
// the private fixtures repo (CI job "fixtures"). Otherwise every test below is skipped and the
// reason is printed. Expected layout and the envelope format are documented in
// src/lib/data/sources/fixtures.ts. TODO(fixtures): tighten the assertions once the first real
// recordings exist and the ASX response shape is confirmed (see asx.ts).
import { describe, expect, it } from "vitest";
import {
  handleAnnouncementsResponse,
  AsxSourceError,
  type AsxResponse,
} from "@/lib/data/sources/asx";
import { listFixtures, readFixtureJson, resolveFixturesDir } from "@/lib/data/sources/fixtures";
import { parseYahooBars } from "@/lib/data/sources/yahoo";

const fx = resolveFixturesDir();
const dir = fx.available ? fx.dir : "";
if (!fx.available) console.info(`[fixtures] ${fx.reason}`);

const yahoo = fx.available ? listFixtures(dir, "yahoo") : [];
const asx = fx.available ? listFixtures(dir, "asx") : [];

describe.skipIf(!fx.available)("real fixtures: Yahoo", () => {
  it.skipIf(yahoo.length === 0)("every recorded chunk is accounted for row by row", () => {
    for (const f of yahoo) {
      const res = parseYahooBars(readFixtureJson(dir, f));
      expect(res.rows.length + res.rejected.length, f).toBe(res.total);
      // Rejected rows never leak into the typed rows.
      expect(new Set(res.rows.map((r) => `${r.code}|${r.date}`)).size, f).toBe(res.rows.length);
    }
  });
});

describe.skipIf(!fx.available)("real fixtures: ASX", () => {
  it.skipIf(asx.length === 0)("every recorded response gives a result or a typed error", () => {
    for (const f of asx) {
      const env = readFixtureJson(dir, f) as AsxResponse;
      try {
        const r = handleAnnouncementsResponse(env);
        expect(["ok", "not_modified"], f).toContain(r.kind);
      } catch (e) {
        expect(e, f).toBeInstanceOf(AsxSourceError);
      }
    }
  });
});
