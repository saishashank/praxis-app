// M21 P1 (PLT-079, UXN-010, D-1231, D-1280; AT-82): the manifest is served to a signed-out browser with the right type
// and the two icons; the service worker registers and answers for the app; offline, a loaded page shows the offline
// badge and a reload shows the built-in offline page (no earlier page is replayed); the worker never stores a page,
// an API answer or a Blueprint or Owner-tool path; Settings has the install row. CI only (needs a production build).
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("the manifest and the worker are public and well typed", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.status()).toBe(200);
  expect(m.headers()["content-type"]).toMatch(/manifest\+json|application\/json/);
  const body = await m.json();
  expect(body.name).toBe("Praxis");
  expect(body.display).toBe("standalone");
  expect(body.start_url).toBe("/");
  expect((body.icons as Array<{ src: string }>).map((i) => i.src)).toEqual([
    "/brand/praxis-app-icon-192.png",
    "/brand/praxis-app-icon-512.png",
  ]);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toMatch(/javascript/);
  const text = await sw.text();
  expect(text).not.toMatch(/PushManager|showNotification|requestPermission/);
});

test("the worker registers, keeps no page, and offline shows the badge and the offline page", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: "allow" });
  await signIn(context, "viewer");
  const page = await context.newPage();
  await page.goto("/picks");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // reload so the page is controlled by the worker
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // the cache holds no page, no API answer and no Blueprint or Owner-tool path
  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const r of await c.keys()) out.push(new URL(r.url).pathname);
    }
    return out;
  });
  for (const p of cached) {
    expect(p).toMatch(/^\/(_next\/static\/|brand\/praxis-app-icon-|icon\.png|apple-icon\.png)/);
  }

  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "Offline" })).toContainText(
    "figures shown may be old",
  );
  await page.reload().catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Praxis is offline" })).toBeVisible();
  await context.setOffline(false);
  await context.close();
});

test("Settings has the install row and no notification prompt", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "viewer");
  // Headless Chromium reports "denied" before any prompt, so the proof is that nothing asks: a spy on
  // the permission request, installed before any page script runs, and no push subscription (D-1291).
  await context.addInitScript(() => {
    const w = window as unknown as { __asked: number };
    w.__asked = 0;
    if ("Notification" in window)
      Notification.requestPermission = (() => {
        w.__asked += 1;
        return Promise.resolve("default");
      }) as typeof Notification.requestPermission;
  });
  const page = await context.newPage();
  await page.goto("/settings");
  await expect(page.getByText("Install Praxis on this device")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
  const subscribed = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    return reg ? (await reg.pushManager.getSubscription()) !== null : false;
  });
  expect(subscribed).toBe(false);
  await context.close();
});
