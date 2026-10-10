// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIXTURES_ENV,
  listFixtures,
  readFixtureJson,
  readFixtureText,
  resolveFixturesDir,
  safeJoin,
  SKIP_MESSAGE,
  syntheticDir,
} from "@/lib/data/sources/fixtures";

const tmp: string[] = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-fx-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveFixturesDir (skip-if-absent)", () => {
  it("is unavailable with a clear message when the variable is unset or blank", () => {
    for (const env of [{}, { [FIXTURES_ENV]: "" }, { [FIXTURES_ENV]: "  " }]) {
      const r = resolveFixturesDir(env);
      expect(r).toEqual({ available: false, reason: SKIP_MESSAGE });
    }
    expect(SKIP_MESSAGE).toContain(FIXTURES_ENV);
  });

  it("is unavailable when the path is missing, a file, or an empty directory", () => {
    const d = mk();
    const file = path.join(d, "f.txt");
    fs.writeFileSync(file, "x");
    const empty = path.join(d, "empty");
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, ".gitkeep"), "");
    for (const p of [path.join(d, "missing"), file, empty]) {
      const r = resolveFixturesDir({ [FIXTURES_ENV]: p });
      expect(r.available).toBe(false);
      if (!r.available) expect(r.reason).toContain("skipped");
    }
  });

  it("is available for a directory with content", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, "yahoo"));
    expect(resolveFixturesDir({ [FIXTURES_ENV]: d })).toEqual({
      available: true,
      dir: path.resolve(d),
    });
  });

  it("reads process.env by default", () => {
    expect(resolveFixturesDir().available).toBe(resolveFixturesDir(process.env).available);
  });
});

describe("reading fixtures", () => {
  it("lists only top-level json files in a subfolder, sorted", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, "asx", "nested"), { recursive: true });
    fs.writeFileSync(path.join(d, "asx", "b.json"), "{}");
    fs.writeFileSync(path.join(d, "asx", "a.json"), "[]");
    fs.writeFileSync(path.join(d, "asx", "note.txt"), "x");
    expect(listFixtures(d, "asx")).toEqual(["asx/a.json", "asx/b.json"]);
    expect(listFixtures(d, "nope")).toEqual([]);
  });

  it("reads text and JSON", () => {
    const d = mk();
    fs.writeFileSync(path.join(d, "a.json"), '{"k":1}');
    expect(readFixtureText(d, "a.json")).toBe('{"k":1}');
    expect(readFixtureJson(d, "a.json")).toEqual({ k: 1 });
  });

  it("refuses paths that escape the directory", () => {
    const d = mk();
    expect(() => safeJoin(d, "../x.json")).toThrow(/escapes/);
    expect(() => safeJoin(d, "a/../../x")).toThrow(/escapes/);
    expect(() => safeJoin(d, path.resolve("/etc/passwd"))).toThrow(/relative/);
    expect(() => safeJoin(d, "a\0b")).toThrow(/relative/);
    expect(safeJoin(d, ".")).toBe(path.resolve(d));
    expect(() => readFixtureText(d, "../x")).toThrow();
    expect(listFixtures(d, "../..")).toEqual([]);
  });
});

describe("synthetic fixtures", () => {
  it("syntheticDir points at tests/fixtures/synthetic", () => {
    expect(syntheticDir("/r")).toBe(path.join("/r", "tests", "fixtures", "synthetic"));
    expect(listFixtures(syntheticDir(), ".").length).toBeGreaterThan(5);
  });

  it("the committed files match the deterministic generator (make-synthetic --check)", () => {
    const out = execFileSync(process.execPath, ["scripts/ingest/make-synthetic.mjs", "--check"], {
      cwd: process.cwd(),
    }).toString();
    expect(out).toContain("up to date");
  });

  it("the generator is deterministic and --out writes elsewhere", () => {
    const a = mk();
    const b = mk();
    for (const d of [a, b]) {
      execFileSync(process.execPath, ["scripts/ingest/make-synthetic.mjs", "--out", d]);
    }
    const names = fs.readdirSync(a).sort();
    expect(names).toEqual(fs.readdirSync(syntheticDir()).sort());
    for (const n of names) {
      expect(fs.readFileSync(path.join(a, n), "utf8")).toBe(
        fs.readFileSync(path.join(b, n), "utf8"),
      );
    }
  });

  it("--check fails when a file differs", () => {
    const d = mk();
    execFileSync(process.execPath, ["scripts/ingest/make-synthetic.mjs", "--out", d]);
    fs.writeFileSync(path.join(d, "bars-good.json"), "[]\n");
    expect(() =>
      execFileSync(process.execPath, ["scripts/ingest/make-synthetic.mjs", "--check", "--out", d], {
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("holds only invented data: fake codes, example.test links, no vendor words", () => {
    for (const f of listFixtures(syntheticDir(), ".")) {
      const text = readFixtureText(syntheticDir(), f.replace(/^\.\//, ""));
      expect(text).not.toMatch(/asx\.com\.au|\.AX\b/);
      for (const m of text.matchAll(/"code": "([^"]*)"/g))
        expect(m[1].toUpperCase()).toMatch(/^ZZ/);
    }
  });
});
