import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkArchitecture, main } from "../ci/architecture-check.mjs";
import { buildModel, MODEL_PATH, render, ROOT } from "./generate.mjs";

const MAP = `version: 1
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
const FILES = {
  "docs/architecture/spec_map.yaml": MAP,
  "src/app/(app)/cortex/page.tsx": "export default function P() { return null; }\n",
  "src/app/api/ping/route.ts": "export async function GET() { return null; }\n",
};

function repo(files = FILES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archchk-"));
  for (const [rel, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), t);
  }
  fs.writeFileSync(path.join(root, MODEL_PATH), render(buildModel(root).model));
  return root;
}
const edit = (root, fn) => {
  const f = path.join(root, MODEL_PATH);
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  fn(m);
  fs.writeFileSync(f, render(m));
};

test("a complete, fresh model passes", () => {
  const root = repo();
  assert.deepEqual(checkArchitecture(root), []);
  const lines = [];
  assert.equal(
    main(root, (l) => lines.push(l)),
    0,
  );
});

test("the real repo model is complete and fresh", () => {
  assert.deepEqual(checkArchitecture(ROOT), []);
});

test("a new route in code that the model lacks is named (stale file)", () => {
  const root = repo();
  fs.mkdirSync(path.join(root, "src/app/api/new"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app/api/new/route.ts"), "export async function GET() {}\n");
  const p = checkArchitecture(root);
  assert.ok(p.includes("in code, missing from the model: route:GET:/api/new"));
  assert.ok(p.some((x) => /is stale/.test(x)));
  assert.equal(
    main(root, () => {}),
    1,
  );
});

test("a ghost element in the model is named", () => {
  const root = repo();
  edit(root, (m) => m.elements.push({ ...m.elements[0], id: "page:/ghost" }));
  assert.ok(checkArchitecture(root).includes("in the model, gone from code: page:/ghost"));
});

test("an element with no spec ID is reported", () => {
  const root = repo();
  edit(root, (m) => (m.elements[0].specIds = []));
  const id = JSON.parse(fs.readFileSync(path.join(root, MODEL_PATH), "utf8")).elements[0].id;
  assert.ok(checkArchitecture(root).some((x) => x.includes(id) && /spec ID/.test(x)));
});

test("an edge whose view is not shared by both ends is reported", () => {
  const root = repo();
  edit(root, (m) => {
    const [a, b] = m.elements;
    a.views = ["platform"];
    b.views = ["data"];
    m.edges.push({
      id: `${a.id}|data|${b.id}`,
      from: a.id,
      to: b.id,
      kind: "data",
      contract: "x",
      views: ["platform"],
    });
  });
  assert.ok(checkArchitecture(root).some((x) => /not shared by both ends/.test(x)));
});

// AT-58 (a): each of the six element kinds is broken once in each direction and named.
const FULL = {
  "docs/architecture/spec_map.yaml": `${MAP}  "service:actions":
    type: service
    name: Actions
    purpose: Runs jobs.
    specIds: [PLT-015]
    owner: actions
    views: [platform]
`,
  "src/app/(app)/cortex/page.tsx": "export default function P() { return null; }\n",
  "src/app/api/ping/route.ts":
    'export async function GET() { return fetch("https://example.org/x"); }\n',
  ".github/workflows/nightly.yml":
    "name: Nightly\non:\n  schedule:\n    - cron: '5 4 * * *'\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.TOKEN_ONE }}\n",
  "db/migrations/main/0001_core.sql":
    "-- +up\nCREATE TABLE thing (id TEXT PRIMARY KEY, name TEXT NOT NULL);\n-- +down\nDROP TABLE thing;\n",
  "worker/src/schedule.ts":
    'export const DISPATCHABLE_WORKFLOWS: readonly string[] = ["nightly.yml"];\nexport const AU_SLOTS = [\n  slot({ id: "night", time: "04:05", runner: "actions", workflow: "nightly.yml", enabled: true, note: "Nightly run" }),\n];\n',
  "src/lib/security/secretStores.ts":
    'const G = "github-env" as const;\nexport const SECRET_ROWS = [\n  {\n    id: "a",\n    slots: [\n      { env: "production", store: G, holder: GH("production"), names: ["TOKEN_ONE"], step: 2 },\n    ],\n  },\n];\n',
};
const KINDS = {
  route: "route:GET:/api/ping",
  workflow: "workflow:nightly",
  table: "table:main.thing",
  slot: "slot:night",
  host: "host:example.org",
  secret: "secret:TOKEN_ONE",
};

test("the six-kind fixture is complete before it is broken", () => {
  const root = repo(FULL);
  assert.deepEqual(checkArchitecture(root), []);
  const ids = JSON.parse(fs.readFileSync(path.join(root, MODEL_PATH), "utf8")).elements.map(
    (e) => e.id,
  );
  for (const id of Object.values(KINDS)) assert.ok(ids.includes(id), id);
});

for (const [kind, id] of Object.entries(KINDS)) {
  test(`${kind}: an element missing from the model is named and the exit is non-zero`, () => {
    const root = repo(FULL);
    edit(root, (m) => (m.elements = m.elements.filter((e) => e.id !== id)));
    assert.ok(checkArchitecture(root).includes(`in code, missing from the model: ${id}`));
    assert.equal(
      main(root, () => {}),
      1,
    );
  });
  test(`${kind}: a ghost element in the model is named and the exit is non-zero`, () => {
    const root = repo(FULL);
    const ghost = `${kind}:ZZ_GHOST`;
    edit(root, (m) => {
      const base = m.elements.find((e) => e.id === id);
      m.elements.push({ ...base, id: ghost });
    });
    assert.ok(checkArchitecture(root).includes(`in the model, gone from code: ${ghost}`));
    assert.equal(
      main(root, () => {}),
      1,
    );
  });
}
