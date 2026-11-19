// M21 A2 (AT-77, AT-82, UX-131, D-1210, D-1214): with the Owner switch OFF (a fresh configuration, lane empty) the three
// Owner-tool pages and /api/owner-tools/* answer exactly what a missing route answers, for anonymous, Viewer, Editor and
// the pinned Owner: status, headers and body, html and RSC. The "on" half is e2e/m21-owner-tools-on.spec.ts.
import { expect, test } from "@playwright/test";
import { expectHiddenEqualsMissing } from "./support/hiddenParity";
import { signIn, type Role } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario(
  "empty",
  "run it in the empty lane (the Owner switch is off in a fresh configuration)",
);

const PAIRS: [string, string][] = [
  ["/recommendations", "/zz-missing"],
  ["/holdings", "/zz-missing"],
  ["/trades", "/zz-missing"],
  ["/api/owner-tools/anything", "/api/zz-missing/anything"],
  ["/api/owner-tools/anything?x=1", "/api/zz-missing/anything?x=1"],
];

for (const role of [null, "viewer", "editor", "owner"] as const) {
  test(`tools off: the Owner tools equal a missing route for ${role ?? "anonymous"}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    if (role) await signIn(context, role as Role);
    await expectHiddenEqualsMissing(context, role ?? "anonymous", PAIRS);
    await context.close();
  });
}

test("a signed-in request for any unknown path equals one for a hidden path (D-1210)", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "viewer");
  await expectHiddenEqualsMissing(context, "viewer", [
    ["/zz-missing-two", "/zz-missing"],
    ["/api/zz-missing-two/x", "/api/zz-missing/x"],
  ]);
  const r = await context.request.get("/holdings", { maxRedirects: 0 });
  expect(r.status()).toBe(404);
  await context.close();
});
