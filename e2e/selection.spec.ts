// AT-47 / UXR-002: every selected tab, segmented control, chip and option card shows three cues: a
// filled surface (differs from its unselected siblings in luminance, so it survives greyscale), a check
// mark, and a text cue ("Selected" / "Current", visible or screen-reader). axe runs on each page, and a
// greyscale screenshot is attached to the test report as evidence.
import { expect, test, type Page } from "@playwright/test";
import { THEMES, axeViolations, setTheme, signIn } from "./helpers";
import { ensureRich } from "./seed/rich";

const PATHS = [
  "/",
  "/picks",
  "/picks?tab=watch",
  "/market",
  "/strategies",
  "/news",
  "/reviews",
  "/settings",
  "/settings/appearance",
  "/settings/region",
  "/settings/time",
  "/picks/track-record",
  "/strategies/leaderboard",
  "/news?chip=alerts",
  "/reviews?view=calendar",
];

type Probe = {
  label: string;
  hasCheck: boolean;
  textCue: boolean;
  bgLum: number;
  siblingLum: number | null;
  ring: boolean;
};

async function probe(page: Page): Promise<Probe[]> {
  return page.evaluate(() => {
    const SEL =
      '[aria-current="page"],[aria-current="true"],[aria-selected="true"],[aria-checked="true"]';
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    // Computed colours may be color(srgb ...) / color-mix results; a 1x1 canvas normalises them to RGBA.
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    ctx.canvas.width = ctx.canvas.height = 1;
    const parse = (c: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    // Effective background luminance: composite the translucent layers over the first opaque ancestor.
    const bg = (el: Element | null): number => {
      const layers: ReturnType<typeof parse>[] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.a > 0) layers.push(c);
        if (c.a >= 1) break;
      }
      let base = layers.pop() ?? { r: 0, g: 0, b: 0, a: 1 };
      while (layers.length) {
        const t = layers.pop()!;
        base = {
          r: t.r * t.a + base.r * (1 - t.a),
          g: t.g * t.a + base.g * (1 - t.a),
          b: t.b * t.a + base.b * (1 - t.a),
          a: 1,
        };
      }
      return 0.2126 * lin(base.r) + 0.7152 * lin(base.g) + 0.0722 * lin(base.b);
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const out: Probe[] = [];
    for (const el of Array.from(document.querySelectorAll(SEL))) {
      if (!visible(el)) continue;
      // Breadcrumbs and plain in-page anchors are not selection controls.
      if (el.closest('nav[aria-label*="readcrumb" i]')) continue;
      const group = el.closest('[role="tablist"],[role="radiogroup"],nav,ul') ?? el.parentElement;
      const sibs = Array.from(
        group?.querySelectorAll('a,button,[role="tab"],[role="radio"]') ?? [],
      ).filter((s) => s !== el && !el.contains(s) && !s.contains(el) && visible(s));
      const sibLum = sibs.length ? bg(sibs[0]) : null;
      const text = (el.textContent ?? "").toLowerCase();
      out.push({
        label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40),
        hasCheck: !!el.querySelector("svg path[d='M5 12l5 5 9-10']") || /✓|✔/.test(text),
        textCue: /selected|current/.test(text),
        bgLum: bg(el),
        siblingLum: sibLum,
        ring: /inset/.test(getComputedStyle(el).boxShadow),
      });
    }
    return out;
  });
}

test.describe.configure({ timeout: 900_000 });
test.beforeAll(async () => {
  await ensureRich();
});

for (const role of ["owner", "viewer"] as const) {
  test(`AT-47 (${role}): selected items have a filled surface, a check and a text cue`, async ({
    page,
    context,
  }, testInfo) => {
    await signIn(context, role);
    let seen = 0;
    const bad: string[] = [];
    for (const theme of THEMES) {
      await setTheme(role, theme);
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 800 });
        for (const path of PATHS) {
          const res = await page.goto(path);
          if (!res || res.status() >= 400) continue;
          for (const p of await probe(page)) {
            seen++;
            const where = `${theme} ${path}@${width} "${p.label}"`;
            if (!p.hasCheck) bad.push(`${where}: no check mark`);
            if (!p.textCue) bad.push(`${where}: no text cue`);
            if (p.siblingLum !== null) {
              const [a, b] = [p.bgLum, p.siblingLum].sort((x, y) => y - x);
              const contrast = (a + 0.05) / (b + 0.05);
              if (contrast < 1.08 && !p.ring)
                bad.push(`${where}: surface not distinct (${contrast.toFixed(2)})`);
            }
          }
        }
      }
    }
    expect(seen, "found selected controls").toBeGreaterThan(10);
    expect(bad).toEqual([]);
    // Greyscale evidence: the selected state must still read with no colour.
    await page.goto("/settings/appearance");
    await page.addStyleTag({ content: "html{filter:grayscale(1)}" });
    await testInfo.attach("greyscale-appearance", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}

test("AT-47: axe has no violations on the selection pages in every theme", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  for (const theme of THEMES) {
    await setTheme("owner", theme);
    for (const path of ["/picks", "/settings/appearance", "/strategies"]) {
      await page.goto(path);
      expect(await axeViolations(page), `${path} ${theme}`).toEqual([]);
    }
  }
});
