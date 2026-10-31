// M16 WP8 / AT-57 (c)(d): the invisibility walk. Every page in the e2e registry, as anonymous, viewer,
// editor and owner: the rendered HTML (nav, gear menu, links) never says "blueprint" to a non-owner;
// the owner sees it only on the Blueprint page itself (the Owner reaches it by typing the address, SEC-111).
// No non-owner response carries model text (D-372). Source files for nav, robots, sitemap and email are
// grepped too. Fixture data only.
import { expect, test, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PAGES } from "./pages";
// @ts-expect-error plain .mjs without types
import { findSecretShapes } from "../scripts/architecture/schema.mjs";
import { EMAIL, ROLE_LIST, concretePath, signIn, type Role } from "./helpers";

const ROOT = process.cwd();
const MODEL = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs/architecture/architecture.json"), "utf8"),
) as { elements: { id: string; type: string }[] };
// Prefixed ids of the kinds that no ordinary page prints (D-372); a hit means model text leaked.
const MODEL_IDS = MODEL.elements
  .filter((e) => ["slot", "workflow", "secret", "table", "llm-role", "host"].includes(e.type))
  .map((e) => e.id);
const BLUEPRINT = /blueprint/i;

function leaks(body: string): string[] {
  return MODEL_IDS.filter((id) => body.includes(id)).slice(0, 5);
}

async function walk(context: BrowserContext, role: Role | null) {
  const seen: string[] = [];
  for (const entry of PAGES) {
    const url = concretePath(entry.path, role ?? "owner");
    if (!url) continue;
    if (role === null && entry.action !== "public") continue;
    const res = await context.request.get(url, { maxRedirects: 5 });
    const html = await res.text();
    seen.push(url);
    if (role === "owner" && url === "/audit") {
      // The owner-only audit log lists the blueprint.view / blueprint.export rows (ARC-003); nothing else may.
      // (no assertion: the rows exist only after an owner visit)
    } else if (role === "owner" && url !== "/blueprint") {
      expect(html, `owner ${url}`).not.toMatch(BLUEPRINT);
    } else if (role !== "owner") {
      expect(html, `${role ?? "anonymous"} ${url}`).not.toMatch(BLUEPRINT);
      expect(leaks(html), `${role ?? "anonymous"} ${url} model text`).toEqual([]);
    }
  }
  return seen;
}

for (const role of [null, ...ROLE_LIST] as (Role | null)[]) {
  test(`walk as ${role ?? "anonymous"}: no "blueprint" in any rendered page`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    if (role) await signIn(context, role);
    const seen = await walk(context, role);
    expect(seen.length).toBeGreaterThan(role === null ? 2 : 20);
    await context.close();
  });
}

for (const role of ROLE_LIST) {
  test(`${role}: nav, gear menu and every link on Home hold no Blueprint link`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    await signIn(context, role);
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Account and settings menu" }).click();
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((as) => as.map((a) => `${a.getAttribute("href")} ${a.textContent}`));
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs.filter((h) => BLUEPRINT.test(h))).toEqual([]);
    await context.close();
  });
}

test("non-owner and anonymous responses to the Blueprint paths carry no model text", async ({
  browser,
  baseURL,
}) => {
  for (const role of [null, "editor", "viewer"] as const) {
    const context = await browser.newContext({ baseURL });
    if (role) await signIn(context, role);
    for (const p of ["/blueprint", "/api/blueprint/model", "/api/blueprint/export"]) {
      const body = await (await context.request.get(p)).text();
      expect(leaks(body), `${role ?? "anonymous"} ${p}`).toEqual([]);
    }
    await context.close();
  }
});

test("the pinned Owner's model response does carry model text (the check can fail)", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const body = await (await context.request.get("/api/blueprint/model")).text();
  expect(leaks(body).length).toBeGreaterThan(0);
  await context.close();
});

test("robots and sitemap do not mention the page", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  expect(text).not.toMatch(BLUEPRINT);
  expect(text.replace(/\r/g, "").trim()).toBe("User-Agent: *\nDisallow: /");
  const sitemap = await request.get("/sitemap.xml", { maxRedirects: 0 });
  expect(sitemap.status()).not.toBe(200); // the app ships no sitemap
  expect(await sitemap.text()).not.toMatch(BLUEPRINT);
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else out.push(full);
  }
  return out;
}

test("nav model, robots, sitemap and email sources never say blueprint (AT-57 d)", () => {
  const files = [
    "src/lib/ui/nav.ts",
    "src/lib/arena/nav.ts",
    "src/app/robots.ts",
    ...["src/app/sitemap.ts", "src/app/sitemap.xml"].filter((f) =>
      fs.existsSync(path.join(ROOT, f)),
    ),
    ...sourceFiles(path.join(ROOT, "src/lib/email")).map((f) => path.relative(ROOT, f)),
    ...sourceFiles(path.join(ROOT, "src/app/api/email")).map((f) => path.relative(ROOT, f)),
  ];
  expect(files.length).toBeGreaterThan(10);
  expect(fs.existsSync(path.join(ROOT, "src/lib/email/templates"))).toBe(true);
  const bad = files.filter((f) => BLUEPRINT.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  expect(bad).toEqual([]);
});

// AT-58 (d): what the pinned Owner is served holds no secret-shaped value and none of this run's
// secrets (the test environment's values from playwright.config.ts).
test("the Owner's responses hold no secret shape and no test-environment secret", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const secrets = ["AUTH_SECRET", "ACTIONS_HMAC_SECRET", "PII_HASH_KEY", "TEST_IDENTITY_SECRET"]
    .map((k) => [k, process.env[k]] as const)
    .filter((kv): kv is readonly [string, string] => Boolean(kv[1]));
  expect(secrets.length).toBeGreaterThan(0);
  const paths = [
    "/blueprint",
    "/blueprint?tab=spec",
    "/api/blueprint/model",
    "/api/blueprint/export?view=platform&format=drawio",
    "/api/blueprint/export?view=platform&format=svg",
  ];
  for (const p of paths) {
    const res = await context.request.get(p);
    expect(res.status(), p).toBe(200);
    const raw = (await res.text()).split(EMAIL.owner).join("");
    // HTML carries framework scripts and styles (build ids, nonces, colour hashes) that look like
    // keys; the shape scan reads the visible markup, the secret-value check below reads everything.
    const body = raw
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<(?:link|meta|noscript)\b[^>]*>/g, "");
    expect(findSecretShapes(body), p).toEqual([]);
    for (const [name, value] of secrets)
      expect(raw.includes(value), `${p} holds ${name}`).toBe(false);
  }
  await context.close();
});
