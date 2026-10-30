// The test runners leave nothing in Temp (Owner 2026-10-30). Every case works inside its own
// scratch base folder, never on os.tmpdir() itself: under the wrapper os.tmpdir() IS the live run
// folder of the whole smoke run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RUN_PREFIX, createRunTemp, removeRunTemp, sweepStaleRunTemps } from "./runTemp.mjs";

const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "with-run-temp.mjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "runtemp-case-"));

test("a run folder holds nested temp folders and is removed whole", () => {
  const base = scratch();
  const { dir, env } = createRunTemp(base);
  assert.ok(path.basename(dir).startsWith(`${RUN_PREFIX}${process.pid}-`));
  assert.equal(env.TEMP, dir);
  assert.equal(env.TMPDIR, dir);
  const inner = fs.mkdtempSync(path.join(dir, "bundle-scan-"));
  fs.writeFileSync(path.join(inner, "x.txt"), "x");
  removeRunTemp(dir);
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("removeRunTemp refuses a folder that is not a run folder and leaves it", () => {
  const base = scratch();
  assert.throws(() => removeRunTemp(base), /not a run folder/);
  assert.equal(fs.existsSync(base), true);
  fs.rmSync(base, { recursive: true, force: true });
});

test("the sweep removes folders of finished runs and keeps live ones and other folders", () => {
  const base = scratch();
  const dead = path.join(base, `${RUN_PREFIX}999999999-abc`); // no such process
  const live = path.join(base, `${RUN_PREFIX}${process.pid}-abc`);
  const other = path.join(base, "hygiene-abc");
  for (const d of [dead, live, other]) fs.mkdirSync(d);
  assert.equal(sweepStaleRunTemps(base), 1);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(other), true);
  fs.rmSync(base, { recursive: true, force: true });
});

test("the wrapper gives the child its own Temp, removes it, and passes the exit code on", () => {
  const script =
    "const fs=require('fs'),os=require('os'),p=require('path');" +
    "fs.mkdtempSync(p.join(os.tmpdir(),'hygiene-'));console.log(os.tmpdir());process.exit(3)";
  const r = spawnSync(process.execPath, [WRAPPER, process.execPath, "-e", script], {
    encoding: "utf8",
  });
  assert.equal(r.status, 3);
  const childTemp = r.stdout.trim();
  assert.ok(path.basename(childTemp).startsWith(RUN_PREFIX));
  assert.equal(fs.existsSync(childTemp), false);
});
