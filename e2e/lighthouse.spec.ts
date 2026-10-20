// AT-26 Lighthouse (decision 59): Home, populated seed, mobile preset, local production build.
// LIGHTHOUSE_CHROME overrides the browser binary. Run through `npm run test:lighthouse` (scripts/ci/lighthouse.mjs sets LIGHTHOUSE=1 and the seed).
// Signs in by minting the session cookie into a persistent Chromium profile, then lets Lighthouse
// attach over the debugging port; Lighthouse keeps cookies, so Home renders as the signed-in Owner.
import { chromium, expect, test, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Metrics } from "../scripts/ci/lighthouse.mjs";
import { importEsm } from "./esm";
import { EMAIL } from "./helpers";
import { createClient } from "@libsql/client";
import { encode } from "next-auth/jwt";

test.skip(
  !process.env.LIGHTHOUSE || process.env.E2E_SCENARIO !== "populated",
  "run through `npm run test:lighthouse` (LIGHTHOUSE=1, populated seed)",
);

const RUNS = 3;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function sessionCookie(): Promise<{ name: string; value: string }> {
  const authDb = createClient({ url: process.env.TURSO_AUTH_URL! });
  try {
    const res = await authDb.execute({
      sql: "SELECT id, session_version FROM app_user WHERE email = ?",
      args: [EMAIL.owner],
    });
    const name = "authjs.session-token";
    const value = await encode({
      token: {
        uid: Number(res.rows[0].id),
        sv: Number(res.rows[0].session_version),
        si: Math.floor(Date.now() / 1000),
        rec: false,
      },
      secret: process.env.AUTH_SECRET!,
      salt: name,
      maxAge: 86400,
    });
    return { name, value };
  } finally {
    authDb.close();
  }
}

test("Home meets the Lighthouse mobile budget", async () => {
  test.setTimeout(420_000);
  const { evaluate, medianMetrics, metricsOf } = await importEsm<
    typeof import("../scripts/ci/lighthouse.mjs")
  >("scripts/ci/lighthouse.mjs");
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-lh-"));
  const cookie = await sessionCookie();
  // Playwright launches Chromium with a debugging pipe, which cannot also serve Lighthouse on a
  // port; so start the browser directly and drive it over CDP.
  const chrome = spawn(
    process.env.LIGHTHOUSE_CHROME ?? chromium.executablePath(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let browser: Browser | undefined;
    for (let i = 0; i < 50 && !browser; i++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
      if (!browser) await new Promise((r) => setTimeout(r, 200));
    }
    expect(browser, "Chromium did not start").toBeTruthy();
    const context = browser!.contexts()[0];
    await context.addCookies([{ ...cookie, url: process.env.APP_BASE_URL! }]);
    const page = context.pages()[0] ?? (await context.newPage());
    const res = await page.goto(`${process.env.APP_BASE_URL}/`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await browser!.close();

    const { default: lighthouse } = await import("lighthouse");
    const runs: Metrics[] = [];
    for (let i = 0; i < RUNS; i++) {
      const result = await lighthouse(`${process.env.APP_BASE_URL}/`, {
        port,
        output: "json",
        logLevel: "error",
        onlyCategories: ["performance"],
      });
      expect(result, "Lighthouse returned no result").toBeTruthy();
      runs.push(metricsOf(result!.lhr));
    }
    const m = medianMetrics(runs);
    console.log(
      `Lighthouse Home (mobile, median of ${RUNS}): performance ${m.performance}, FCP ${Math.round(m.fcpMs)} ms, LCP ${Math.round(m.lcpMs)} ms, CLS ${m.cls.toFixed(3)}`,
    );
    const { failures, warnings } = evaluate(m);
    for (const w of warnings) console.log(`::warning::Lighthouse Home: ${w}`);
    expect(failures, failures.join("; ")).toEqual([]);
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows may still hold the profile for a moment; it is a temp folder.
    }
  }
});
