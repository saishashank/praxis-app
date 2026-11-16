// Tests for scripts/routes/gen-app-routes.mjs (M21 A2, D-1210).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { render, ROOT, scanRoutes } from "./gen-app-routes.mjs";

const SCRIPT = fileURLToPath(new URL("./gen-app-routes.mjs", import.meta.url));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen-routes-"));
  const put = (rel, text = "export {};\n") => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put("src/app/(app)/page.tsx");
  put("src/app/(app)/picks/page.tsx");
  put("src/app/(app)/market/[code]/page.tsx");
  put("src/app/(app)/(owner-tools)/holdings/page.tsx");
  put("src/app/(app)/@modal/(.)cards/[id]/page.tsx");
  put("src/app/(app)/@modal/default.tsx");
  put("src/app/api/auth/[...nextauth]/route.ts");
  put(
    "src/app/api/x/export/route.ts",
    'new Response("", { headers: { "Content-Disposition": "attachment" } });',
  );
  put("src/app/api/y/route.ts");
  put("src/app/robots.ts");
  put("src/app/icon.png");
  put("src/app/layout.tsx");
  put("src/app/opengraph-image.tsx");
  put("src/app/(app)/apple-icon.js");
  put("src/app/sitemap.xml");
  put("src/app/(app)/_private/page.tsx");
  put("src/app/(app)/_lib/deep/page.tsx");
  put("src/app/(app)/photo/(.)gallery/page.tsx");
  put("src/app/(app)/photo/(..)feed/page.tsx");
  put("public/brand/logo.svg");
  put("public/sw.js");
  return root;
}

test("scan: pages, groups removed, slots skipped, handlers, metadata and public files", () => {
  const { patterns, exportRoutes } = scanRoutes(fixture());
  assert.deepEqual(patterns, [
    "/",
    "/api/auth/[...nextauth]",
    "/api/x/export",
    "/api/y",
    "/apple-icon",
    "/brand/logo.svg",
    "/holdings",
    "/icon.png",
    "/market/[code]",
    "/opengraph-image",
    "/picks",
    "/robots.txt",
    "/sitemap.xml",
    "/sw.js",
  ]);
  assert.deepEqual(exportRoutes, ["/api/x/export"]);
});

test("the checked-in generated module equals a fresh scan of the repository", async () => {
  const have = fs.readFileSync(path.join(ROOT, "src/lib/http/appRoutes.generated.ts"), "utf8");
  assert.equal(have, await render(ROOT));
  const r = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("a usage error exits 2", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
