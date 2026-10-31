import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generate as routeCoverage } from "../ci/route-coverage.mjs";
import { buildModel, globRe, main, MODEL_PATH, render, ROOT } from "./generate.mjs";
import {
  ELEMENT_TYPES,
  findSecretShapes,
  ID_RE,
  SPEC_ID_RE,
  validateModel,
  VIEW_IDS,
} from "./schema.mjs";
import { parseYaml } from "./yaml.mjs";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const MAP = `
version: 1
rules:
  - match: "*"
    specIds: [PLT-001]
    purpose: "Thing {name}."
    views: [platform]
elements:
  "service:app":
    type: service
    name: App
    purpose: The app.
    specIds: [PLT-020]
    owner: app
    views: [platform]
`;

const SMALL = {
  "docs/architecture/spec_map.yaml": MAP,
  "src/app/(app)/cortex/page.tsx": "export default function P() { return null; }\n",
  "src/app/api/ping/route.ts":
    'export async function GET() { return fetch("https://example.org/x"); }\n',
  "src/app/(app)/x/actions.ts": '"use server";\nexport async function saveThing() {}\n',
  ".github/workflows/nightly.yml":
    "name: Nightly\non:\n  schedule:\n    - cron: '5 4 * * *'\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.TOKEN_ONE }}\n",
  "db/migrations/main/0001_core.sql":
    "-- +up\nCREATE TABLE thing (id TEXT PRIMARY KEY, name TEXT NOT NULL, PRIMARY KEY (id));\nCREATE INDEX idx_thing_name ON thing (name);\n-- +down\nDROP TABLE thing;\n",
  "db/migrations/auth/0001_auth.sql": "-- +up\nCREATE TABLE app_user (id TEXT);\n",
  "worker/src/schedule.ts":
    'export const DISPATCHABLE_WORKFLOWS: readonly string[] = ["nightly.yml"];\nexport const AU_SLOTS = [\n  slot({ id: "night", time: "04:05", runner: "actions", workflow: "nightly.yml", enabled: true, note: "Nightly run" }),\n];\n',
  "src/lib/security/secretStores.ts":
    'const G = "github-env" as const;\nexport const SECRET_ROWS = [\n  {\n    id: "a",\n    slots: [\n      { env: "production", store: G, holder: GH("production"), names: ["TOKEN_ONE"], step: 2 },\n    ],\n  },\n];\n',
};

test("synthetic repo: routes, workflow, table, slot, secret and host become elements and edges", () => {
  const root = fixture(SMALL);
  const { model, problems } = buildModel(root);
  assert.deepEqual(problems, []);
  const ids = model.elements.map((e) => e.id);
  for (const want of [
    "page:/cortex",
    "route:GET:/api/ping",
    "action:src/app/(app)/x/actions.ts#saveThing",
    "workflow:nightly",
    "table:main.thing",
    "table:auth.app_user",
    "slot:night",
    "secret:TOKEN_ONE",
    "host:example.org",
    "service:app",
  ]) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
  const edge = (from, kind, to) =>
    model.edges.some((g) => g.from === from && g.kind === kind && g.to === to);
  assert.ok(edge("slot:night", "dispatch", "workflow:nightly"));
  assert.ok(edge("workflow:nightly", "uses", "secret:TOKEN_ONE"));
  assert.ok(edge("route:GET:/api/ping", "http", "host:example.org"));
  const table = model.elements.find((e) => e.id === "table:main.thing");
  assert.deepEqual(table.attrs.indexes, ["idx_thing_name"]);
  assert.deepEqual(table.attrs.columns, ["id", "name"]);
  const wf = model.elements.find((e) => e.id === "workflow:nightly");
  assert.equal(wf.schedule, "cron (UTC): 5 4 * * *");
  assert.deepEqual(wf.attrs.jobs, ["build"]);
  assert.equal(model.elements.find((e) => e.id === "slot:night").attrs.dispatchable, true);
  assert.deepEqual(model.elements.find((e) => e.id === "secret:TOKEN_ONE").attrs.stores, [
    "production: github-env (GitHub environment `production`)",
  ]);
  assert.deepEqual(validateModel(model), []);
});

test("an element without a spec ID, and a spec_map entry for something gone, are reported", () => {
  const noMap = fixture({ ...SMALL, "docs/architecture/spec_map.yaml": "version: 1\n" });
  const a = buildModel(noMap);
  assert.ok(a.problems.some((p) => /needs at least one spec ID/.test(p)));
  const gone = fixture({
    ...SMALL,
    "docs/architecture/spec_map.yaml": MAP + '  "route:GET:/api/removed":\n    purpose: x\n',
  });
  assert.ok(
    buildModel(gone).problems.some((p) => /route:GET:\/api\/removed.*not in the code/.test(p)),
  );
});

test("a hand edge across views the ends do not share is reported", () => {
  const root = fixture({
    ...SMALL,
    "docs/architecture/spec_map.yaml":
      MAP +
      'edges:\n  - { from: "service:app", to: "page:/cortex", kind: data, views: [security] }\n',
  });
  assert.ok(buildModel(root).problems.some((p) => /not shared by both ends/.test(p)));
});

test("generation is deterministic and the file is sorted", () => {
  const root = fixture(SMALL);
  const a = render(buildModel(root).model);
  const b = render(buildModel(root).model);
  assert.equal(a, b);
  const ids = JSON.parse(a).elements.map((e) => e.id);
  assert.deepEqual(
    ids,
    [...ids].sort((x, y) => (x < y ? -1 : 1)),
  );
});

test("--check passes on a fresh file and fails on a stale one", () => {
  const root = fixture(SMALL);
  const out = [];
  assert.equal(
    main(["--check"], root, (l) => out.push(l)),
    1,
    "no file yet",
  );
  assert.equal(
    main([], root, () => {}),
    0,
  );
  assert.equal(
    main(["--check"], root, () => {}),
    0,
  );
  fs.appendFileSync(path.join(root, MODEL_PATH), " ");
  assert.equal(
    main(["--check"], root, (l) => out.push(l)),
    1,
  );
  assert.ok(out.some((l) => /stale/.test(l)));
  assert.equal(
    main([], root, () => {}),
    0,
  );
  fs.appendFileSync(
    path.join(root, "src/app/api/ping/route.ts"),
    "export async function POST() {}\n",
  );
  assert.equal(
    main(["--check"], root, () => {}),
    1,
    "a new route makes the committed model stale",
  );
});

test("secret scan: shapes are caught, names are not", () => {
  const bad = [
    "ghp_" + "a1B2c3D4".repeat(4),
    "sk-" + "Zx9".repeat(10),
    "AKIA" + "ABCDEFGH12345678",
    "eyJ" + "hbGciOi".repeat(2) + "." + "eyJzdWIi".repeat(2) + ".sig",
    "a".repeat(8) + "0123456789abcdef".repeat(2),
    "owner" + "@" + "mail.test.dev",
    "libsql" + "://db.example.test",
    "Bearer " + "abcDEF123456".repeat(2),
    "A1b2".repeat(11),
  ];
  for (const s of bad)
    assert.ok(findSecretShapes(`x ${s} y`).length > 0, `not caught: ${s.slice(0, 6)}`);
  for (const ok of [
    "GITHUB_DISPATCH_TOKEN",
    "TURSO_MAIN_TOKEN_PROD",
    "src/lib/security/secretStores.ts",
    "api.github.com",
    "2026-10-31",
  ]) {
    assert.deepEqual(findSecretShapes(ok), [], ok);
  }
});

test("globs: star, question mark and braces", () => {
  assert.ok(globRe("table:main.{a,b}_x").test("table:main.b_x"));
  assert.ok(!globRe("table:main.{a,b}_x").test("table:main.c_x"));
  assert.ok(globRe("route:*:/api/*").test("route:GET:/api/a/[id]"));
  assert.ok(globRe("a.b").test("a.b") && !globRe("a.b").test("axb"));
});

test("yaml subset: maps, lists, flow, block scalars, comments, quoted keys", () => {
  const y = parseYaml(
    [
      "# c",
      "a: 1",
      "b: [x, 'y z', 3]",
      'c: { k: v, "q": true }',
      "d:",
      "  - one",
      "  - key: v # trailing",
      "    other: [1,",
      "      2]",
      "e: |",
      "  line1",
      "  line2",
      '"f:g": null',
      "on:",
      "  push:",
      "    branches: [main]",
    ].join("\n"),
  );
  assert.equal(y.a, 1);
  assert.deepEqual(y.b, ["x", "y z", 3]);
  assert.deepEqual(y.c, { k: "v", q: true });
  assert.deepEqual(y.d, ["one", { key: "v", other: [1, 2] }]);
  assert.equal(y.e, "line1\nline2");
  assert.equal(y["f:g"], null);
  assert.deepEqual(y.on.push.branches, ["main"]);
});

// ---- the real repository ----

const real = buildModel(ROOT);

test("real repo: generates without a problem and every element has a valid spec ID", () => {
  assert.deepEqual(real.problems, []);
  for (const e of real.model.elements) {
    assert.ok(e.specIds.length >= 1, e.id);
    for (const s of e.specIds) assert.match(s, SPEC_ID_RE, e.id);
    assert.match(e.id, ID_RE);
    assert.ok(ELEMENT_TYPES.includes(e.type));
    assert.ok(e.views.every((v) => VIEW_IDS.includes(v)));
  }
  for (const v of VIEW_IDS)
    assert.ok(
      real.model.elements.some((e) => e.views.includes(v)),
      `empty view ${v}`,
    );
});

test("real repo: the committed architecture.json matches the code (D-366)", () => {
  const out = [];
  assert.equal(
    main(["--check"], ROOT, (l) => out.push(l)),
    0,
    out.join("\n"),
  );
});

test("real repo: routes and actions equal route-coverage's list; no secret-shaped value in the model", () => {
  const ids = new Set(real.model.elements.map((e) => e.id));
  for (const key of routeCoverage(ROOT).keys()) {
    const id = key.startsWith("action ")
      ? "action:" + key.slice(7)
      : "route:" + key.replace(" ", ":");
    assert.ok(ids.has(id), `model lacks ${id}`);
  }
  const text = fs.readFileSync(path.join(ROOT, MODEL_PATH), "utf8");
  assert.deepEqual(findSecretShapes(text), []);
  assert.equal(text, render(JSON.parse(text)));
});
