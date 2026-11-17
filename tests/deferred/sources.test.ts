// @vitest-environment node
// M22 E5 (DAT-249, DAT-250, D-1442): two data sources that stay out, with their reason and the date checked; no fetcher, host or
// key exists for either.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REJECTED_SOURCES,
  RejectedSourceError,
  refuseRejectedSource,
} from "@/lib/deferred/sources";

describe("rejected sources", () => {
  it("lists exactly DAT-249 and DAT-250, rejected, with a reason and the day checked", () => {
    expect(REJECTED_SOURCES.map((s) => [s.id, s.status])).toEqual([
      ["DAT-249", "REJECTED"],
      ["DAT-250", "REJECTED"],
    ]);
    for (const s of REJECTED_SOURCES) {
      expect(s.reason.length).toBeGreaterThan(40);
      expect(s.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it.each(REJECTED_SOURCES.map((s) => s.id))(
    "refuseRejectedSource(%s) throws with the reason",
    (id) => {
      const s = REJECTED_SOURCES.find((x) => x.id === id)!;
      try {
        refuseRejectedSource(id);
        expect.unreachable("must throw");
      } catch (e) {
        expect(e).toBeInstanceOf(RejectedSourceError);
        expect((e as RejectedSourceError).id).toBe(id);
        expect((e as Error).message).toContain(s.reason);
      }
    },
  );

  it("an unknown id is a programming error", () => {
    expect(() => refuseRejectedSource("DAT-1")).toThrow(RangeError);
  });

  it("no fetcher, host, register row or key exists for either", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(n) ? [p] : [];
      });
    const files = [...walk("src"), ...walk("scripts")].filter(
      (f) => !f.replace(/\\/g, "/").endsWith("deferred/sources.ts"),
    );
    const hits = files.filter((f) => /DAT-249|DAT-250/.test(readFileSync(f, "utf8")));
    // the ids may be cited in comments; no register row, host list or config key carries them
    for (const f of hits) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/PENDING_SOURCE_ROWS|hosts:\s*\["/);
    }
    expect(files.filter((f) => /social|level2/i.test(f))).toEqual([]);
    const keys = readFileSync("src/lib/config/keys.ts", "utf8");
    expect(keys).not.toMatch(/social_|realtime|level_2_data|order_book/i);
  });
});
