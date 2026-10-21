import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { BUDGETS, evaluate, normChunk, table } from "./bundle-budget.mjs";

// Incompressible bytes, so the gzip size is close to the raw size.
const noise = (n, tag = "") => Buffer.concat([Buffer.from(tag), crypto.randomBytes(n)]);

const FILES = {
  "static/chunks/shared.js": noise(50_000),
  "static/chunks/home.js": noise(60_000),
  "static/chunks/market.js": noise(20_000),
  "static/chunks/charts.js": noise(30_000, "x tv-lightweight-charts y"),
};
const read = (c) => FILES[c];
const R = (route, ...names) => ({
  route,
  firstLoadChunkPaths: ["shared", ...names].map((n) => `.next\\static\\chunks\\${n}.js`),
});
const BUD = { ...BUDGETS, routes: { "/": 150 }, chartRoutes: ["/market/[code]"] };

test("normChunk handles Windows separators and the .next prefix", () => {
  assert.equal(normChunk(".next\\static\\chunks\\a.js"), "static/chunks/a.js");
  assert.equal(normChunk(".next/static/chunks/a.js"), "static/chunks/a.js");
});

test("within budget: shared is the intersection, route totals include shared", () => {
  const r = evaluate([R("/", "home"), R("/market/[code]", "market", "charts")], read, BUD);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.shared.chunks, ["static/chunks/shared.js"]);
  assert.deepEqual(r.chartChunks, ["static/chunks/charts.js"]);
  assert.ok(r.routes[0].bytes > r.shared.bytes);
});

test("over the shared budget fails", () => {
  const r = evaluate([R("/", "home")], read, { ...BUD, sharedKb: 10 });
  assert.ok(r.failures.some((f) => f.includes("shared first-load JS")));
});

test("over a route budget fails and the table marks it", () => {
  const b = { ...BUD, routes: { "/": 100 } };
  const r = evaluate([R("/", "home")], read, b);
  assert.ok(r.failures.some((f) => f.startsWith("route / ")));
  assert.match(table(r, b), /route \/\s+\d+\.\d\s+100\s+OVER/);
});

test("Lightweight Charts in another route's first load fails", () => {
  const r = evaluate(
    [R("/", "home", "charts"), R("/market/[code]", "market", "charts")],
    read,
    BUD,
  );
  assert.ok(r.failures.some((f) => f.includes("route / loads Lightweight Charts")));
  assert.ok(!r.failures.some((f) => f.includes("/market/[code] loads")));
});

test("a budgeted route missing from the build is reported", () => {
  const r = evaluate([R("/market/[code]", "market")], read, BUD);
  assert.ok(r.failures.some((f) => f.includes("route / is missing")));
});
