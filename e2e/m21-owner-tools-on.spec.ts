// M21 A2 (AT-77, UX-131, D-1214, D-1243): with the Owner switch ON (state owner-tools-on) the pinned Owner reaches the
// Owner-tool pages and Editors and Viewers still get exactly what a missing route gets. Lane: rich with
// E2E_STATES="all,owner-tools-on" (the state is opt-in, D-1243).
// The Owner's 200 is asserted for each page whose file exists: B1 adds /recommendations and /holdings, B2 adds /trades,
// so a stream that has not landed yet does not fail this lane (D-1246).
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { expectHiddenEqualsMissing } from "./support/hiddenParity";
import { signIn, type Role } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario(
  "rich",
  'run it in the rich lane: E2E_SCENARIO=rich E2E_STATES="all,owner-tools-on"',
);
if (!(process.env.E2E_STATES ?? "").split(",").includes("owner-tools-on")) {
  throw new Error(
    'this spec needs E2E_STATES to include owner-tools-on, e.g. E2E_STATES="all,owner-tools-on" (TST-134)',
  );
}

const PAGES = ["recommendations", "holdings", "trades"] as const;
const exists = (p: string) => fs.existsSync(`src/app/(app)/(owner-tools)/${p}/page.tsx`);

for (const role of [null, "viewer", "editor"] as const) {
  test(`tools on: the Owner tools still equal a missing route for ${role ?? "anonymous"}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    if (role) await signIn(context, role as Role);
    await expectHiddenEqualsMissing(context, role ?? "anonymous", [
      ...PAGES.map((p): [string, string] => [`/${p}`, "/zz-missing"]),
      ["/api/owner-tools/anything", "/api/zz-missing/anything"],
    ]);
    await context.close();
  });
}

for (const p of PAGES) {
  test(`tools on: the pinned Owner gets /${p}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner");
    const res = await context.request.get(`/${p}`, { maxRedirects: 0 });
    // before the page exists the pinned Owner gets the missing route's 404, like everyone else
    expect(res.status()).toBe(exists(p) ? 200 : 404);
    await context.close();
  });
}
