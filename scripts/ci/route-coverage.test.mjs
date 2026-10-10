import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  actionNames,
  check,
  generate,
  hasUseServer,
  routeMethods,
  urlPathFor,
} from "./route-coverage.mjs";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-cov-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const BASE = {
  "src/app/api/health/route.ts": "export function GET() { return new Response('ok'); }",
  "src/app/api/items/[id]/route.ts":
    "export async function POST() {}\nexport const DELETE = async () => {};",
  "src/app/api/auth/[...nextauth]/route.ts": "export const { GET, POST } = handlers;",
  "src/app/(app)/users/actions.ts":
    '"use server";\nexport async function inviteUser() {}\nexport const revoke = async () => {};\nfunction helper() {}',
  "src/lib/plain.ts": "export async function notAnAction() {}",
  "tests/health.test.ts": "fetch('/api/health')",
  "tests/items.test.ts": "import('@/app/api/items/[id]/route')",
  "tests/auth.test.ts": "config only",
  "tests/users.test.ts": "inviteUser(); revoke();",
};

const GOOD = {
  routes: {
    "GET /api/health": { tests: ["tests/health.test.ts"] },
    "POST /api/items/[id]": { tests: ["tests/items.test.ts"] },
    "DELETE /api/items/[id]": { tests: ["tests/items.test.ts"] },
    "GET /api/auth/[...nextauth]": { owner: "auth.js", tests: ["tests/auth.test.ts"] },
    "POST /api/auth/[...nextauth]": { owner: "auth.js", tests: ["tests/auth.test.ts"] },
    "action src/app/(app)/users/actions.ts#inviteUser": { tests: ["tests/users.test.ts"] },
    "action src/app/(app)/users/actions.ts#revoke": { tests: ["tests/users.test.ts"] },
  },
};

test("parsers", () => {
  assert.deepEqual(routeMethods("export const { GET, POST } = h;"), ["GET", "POST"]);
  assert.deepEqual(routeMethods("// export function GET\nexport async function PUT(){}"), ["PUT"]);
  assert.equal(hasUseServer('// c\n"use server"\nexport async function a(){}'), true);
  assert.equal(hasUseServer('import x from "y";\n"use server";'), false);
  assert.deepEqual(actionNames("export async function b(){}\nexport const a = async () => {}"), [
    "a",
    "b",
  ]);
  assert.equal(urlPathFor("(app)/api/x/[id]"), "/api/x/[id]");
});

test("generates routes and actions, ignoring non-action files", () => {
  const ids = [...generate(fixture(BASE)).keys()].sort();
  assert.equal(ids.length, 7);
  assert.ok(ids.includes("action src/app/(app)/users/actions.ts#revoke"));
  assert.ok(!ids.some((i) => i.includes("notAnAction")));
});

test("complete manifest passes", () => {
  assert.deepEqual(check(fixture(BASE), GOOD).problems, []);
});

test("(a) a route missing from the manifest fails", () => {
  const m = structuredClone(GOOD);
  delete m.routes["GET /api/health"];
  const { problems } = check(fixture(BASE), m);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /untested: GET \/api\/health/);
});

test("(b) a stale manifest entry fails", () => {
  const m = structuredClone(GOOD);
  m.routes["PATCH /api/gone"] = { tests: ["tests/health.test.ts"] };
  assert.match(check(fixture(BASE), m).problems.join("\n"), /stale: .*PATCH \/api\/gone/);
});

test("(c) a missing test file and an unmentioned route fail", () => {
  const m = structuredClone(GOOD);
  m.routes["GET /api/health"] = { tests: ["tests/nope.test.ts"] };
  m.routes["POST /api/items/[id]"] = { tests: ["tests/health.test.ts"] };
  const text = check(fixture(BASE), m).problems.join("\n");
  assert.match(text, /missing file: GET \/api\/health/);
  assert.match(text, /not mentioned: .*POST \/api\/items\/\[id\]/);
});

test("an entry with no tests fails", () => {
  const m = structuredClone(GOOD);
  m.routes["GET /api/health"] = { tests: [] };
  assert.match(check(fixture(BASE), m).problems.join("\n"), /no tests: GET \/api\/health/);
});

test("a new server action without tests fails", () => {
  const files = { ...BASE, "src/lib/x.ts": '"use server";\nexport async function danger() {}' };
  const text = check(fixture(files), GOOD).problems.join("\n");
  assert.match(text, /untested: action src\/lib\/x\.ts#danger/);
});
