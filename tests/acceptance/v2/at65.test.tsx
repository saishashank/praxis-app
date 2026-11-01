// AT-65 (M17 WP7/WP8; UXN-311, D-393): (b) every family badge passes WCAG contrast in every theme (the
// mark on its fill, the coloured text on bg and surface), from the same checker CI runs on themes.css;
// (c) the "i" sheet of every family renders the four plain-words rows and the Strategies link; (d) one
// badge table, the mark never relies on hue alone. Final review (Fable, D-479 series). No network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { check, THEME_NAMES } from "../../../scripts/ci/contrast-check.mjs";
import { FAMILY_CODES } from "@/components/ui/Family";
import { FAMILY_BADGE } from "@/lib/ui/familyBadge";
import { PickFamily } from "@/app/(app)/picks/FamilyInfo";

afterEach(cleanup);

const CSS = readFileSync(join(process.cwd(), "src/styles/themes.css"), "utf8");

describe("AT-65 (b) badge contrast per family and theme", () => {
  it("mark on fill (text) and coloured text on bg / surface pass in all five themes", () => {
    const { results, failures } = check(CSS);
    expect(failures.filter((f) => /family-/.test(f))).toEqual([]);
    for (const theme of THEME_NAMES) {
      for (const code of FAMILY_CODES) {
        const h = `family-${code}`;
        const got = results.filter((r) => r.theme === theme && r.fg.startsWith(h));
        const pairs = got.map((r) => `${r.fg}/${r.bg}`);
        expect(pairs, `${theme} ${h}`).toEqual(
          expect.arrayContaining([
            `${h}-on-fill/${h}-fill`,
            `${h}-text/bg`,
            `${h}-text/surface`,
            `${h}-fill/bg`,
            `${h}-fill/surface`,
          ]),
        );
        for (const r of got)
          expect(r.ok, `${theme} ${r.fg} on ${r.bg} ${r.ratio.toFixed(2)}`).toBe(true);
      }
    }
  });

  it("every badge in the table has a hue token in every theme", () => {
    const { themes } = check(CSS);
    for (const theme of THEME_NAMES) {
      for (const b of Object.values(FAMILY_BADGE)) {
        for (const suffix of ["fill", "text", "on-fill"]) {
          expect(
            themes[theme]![`family-${b.code}-${suffix}`],
            `${theme} ${b.code} ${suffix}`,
          ).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });
});

describe("AT-65 (c) the i sheet per family", () => {
  const info = {
    oneLiner: "One line.",
    buys: "when it buys",
    sells: "when it sells",
    worksBest: "when it works",
    mainRisk: "when it breaks",
  };
  for (const [family, b] of Object.entries(FAMILY_BADGE)) {
    it(
      `${family} ${b.label}: badge with mark, i trigger, four rows and the Strategies link`,
      { timeout: 15000 },
      async () => {
        render(<PickFamily pick={{ family, familyName: b.label, familyInfo: info }} />);
        const badge = document.querySelector("[data-family]")!;
        expect(badge.getAttribute("data-family")).toBe(b.code);
        expect(badge.textContent).toContain(b.mark);
        expect(badge.textContent).toContain(b.label);
        fireEvent.click(screen.getByRole("link", { name: `About ${b.label}` }));
        // the dialog chunk is lazy: the first open may take longer than the 1 s default
        const sheet = await screen.findByTestId("family-sheet", {}, { timeout: 8000 });
        const text = sheet.textContent ?? "";
        for (const row of ["Buys when", "Sells when", "Works best when", "Usually breaks when"]) {
          expect(text).toContain(row);
        }
        for (const v of Object.values(info)) expect(text).toContain(v);
        expect(sheet.querySelector('a[href="/strategies"]')).not.toBeNull();
        expect(text).not.toMatch(/real[- ]?time|buy now|guarantee/i);
      },
    );
  }

  it("a family without stored words still opens with a plain fallback", async () => {
    render(<PickFamily pick={{ family: "F1", familyName: "Breakout", familyInfo: null }} />);
    fireEvent.click(screen.getByRole("link", { name: "About Breakout" }));
    const sheet = await screen.findByTestId("family-sheet");
    expect(sheet.textContent).toContain("No description is stored for this strategy.");
  });
});

describe("AT-65 (d) one badge table", () => {
  it("eight codes, each with a two-letter mark that is not a hue", () => {
    expect(Object.keys(FAMILY_BADGE).sort()).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "ID",
    ]);
    for (const b of Object.values(FAMILY_BADGE)) {
      expect(FAMILY_CODES).toContain(b.code);
      expect(b.mark).toMatch(/^[A-Z]{2}$/);
    }
  });
});
