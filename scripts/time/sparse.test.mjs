// D-1851: the schedule-gate jobs of ingest-batch1.yml and watchdog.yml check out only scripts/time
// (sparse-checkout). Every module there must import only node: built-ins or files inside
// scripts/time, or the gate fails with ERR_MODULE_NOT_FOUND before ingest runs (19 Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_TZ as GATE_TZ } from "./genWatchdogCron.mjs";
import { OWNER_TZ } from "../../src/lib/market/profileCore.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const modules = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
const SPEC =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

test("scripts/time modules import only node: built-ins or siblings (sparse checkout)", () => {
  assert.ok(modules.includes("genWatchdogCron.mjs") && modules.includes("scheduleGate.mjs"));
  for (const f of modules) {
    const src = readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1] ?? m[2];
      const ok = spec.startsWith("node:") || (spec.startsWith("./") && !spec.includes("/", 2));
      assert.ok(
        ok,
        `${f} imports ${spec}, which the sparse checkout of scripts/time does not contain`,
      );
    }
  }
});

test("the gate's Owner time zone equals the app's OWNER_TZ", () => {
  assert.equal(GATE_TZ, OWNER_TZ);
});

test("the gate files resolve with only scripts/time present", async () => {
  // Load from a copy of scripts/time alone, like the sparse checkout.
  const { mkdtempSync, cpSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "praxis-sparse-"));
  try {
    const copy = path.join(root, "scripts", "time");
    cpSync(dir, copy, { recursive: true });
    const { pathToFileURL } = await import("node:url");
    const gate = await import(pathToFileURL(path.join(copy, "scheduleGate.mjs")).href);
    assert.equal(typeof gate.gate, "function");
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle; the temp sweep removes it */
    }
  }
});
