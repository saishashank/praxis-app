// @vitest-environment node
// M22 L1 (LLM-077, D-1401): no live provider is built anywhere but the factory (the night) and the bake-off CLI. The scan
// covers the app, the scripts and the worker source: `createLiveProvider`, `providerForRoster` and a router in
// `mode: "live"` appear only where the design allows. providers.ts holds the definitions.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_HOST_SUFFIXES,
  isBlockedHost,
  LLM_PROVIDER_HOST_SUFFIXES,
} from "@/lib/data/recorded/hostGuard.mjs";
import { ROOT } from "../db/helpers";

const norm = (p: string) => p.split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|mts)$/.test(e.name)) out.push(full);
  }
  return out;
}

const SCANNED = ["src", "scripts", "worker/src"]
  .map((d) => path.join(ROOT, d))
  .flatMap((d) => {
    try {
      return walk(d);
    } catch {
      return [];
    }
  })
  .map((f) => norm(path.relative(ROOT, f)))
  // tests that sit beside scripts are not production code
  .filter((f) => !/\.test\.(mjs|ts|tsx)$/.test(f));

const sitesOf = (re: RegExp): string[] =>
  SCANNED.filter((f) => re.test(readFileSync(path.join(ROOT, f), "utf8"))).sort();

describe("live provider construction sites", () => {
  it("createLiveProvider: defined in providers.ts, used only by the factory and the bake-off CLI", () => {
    expect(sitesOf(/\bcreateLiveProvider\b/)).toEqual(
      ["src/lib/llm/bakeoffCli.ts", "src/lib/llm/providers.ts"].sort(),
    );
  });

  it("providerForRoster: defined in providers.ts, called only from the factory", () => {
    const sites = sitesOf(/\bproviderForRoster\b/);
    expect(sites).toContain("src/lib/llm/factory.ts");
    expect(
      sites.filter((f) => f !== "src/lib/llm/providers.ts" && f !== "src/lib/llm/factory.ts"),
    ).toEqual([]);
  });

  it('a router in mode "live" is configured only in the factory and the bake-off CLI', () => {
    expect(sitesOf(/\bmode:\s*(?:\w+\s*\?\s*)?"live"/)).toEqual([
      "src/lib/llm/bakeoffCli.ts",
      "src/lib/llm/factory.ts",
    ]);
  });

  it("the night seam names no provider and no live mode", () => {
    const text = readFileSync(path.join(ROOT, "src/lib/llm/nightlyLlm.ts"), "utf8");
    expect(text).not.toMatch(
      /createLiveProvider|createMockProvider|providerForRoster|mode:\s*"(live|mock)"|createRouter/,
    );
    expect(text).toContain('from "./factory"');
  });

  it("the scan reads real files (a guard against a path error making every list empty)", () => {
    expect(SCANNED).toContain("src/lib/llm/factory.ts");
    expect(SCANNED.length).toBeGreaterThan(100);
  });
});

describe("recorded-day host guard (LLM-077)", () => {
  const ENDPOINTS = [
    "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
    "https://api.groq.com/openai/v1/chat/completions",
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.cloudflare.com/client/v4/accounts/x/ai/run/y", // Workers AI (M22 L3)
  ];
  it("names the four provider hosts, and every adapter endpoint is blocked", () => {
    expect(LLM_PROVIDER_HOST_SUFFIXES).toHaveLength(4);
    for (const s of LLM_PROVIDER_HOST_SUFFIXES) expect(BLOCKED_HOST_SUFFIXES).toContain(s);
    for (const u of ENDPOINTS) expect(isBlockedHost(new URL(u).hostname), u).toBe(true);
  });

  it("the endpoints in providers.ts and workersAi.ts are exactly the ones the guard names", () => {
    const text = ["providers.ts", "workersAi.ts"]
      .map((f) => readFileSync(path.join(ROOT, "src/lib/llm", f), "utf8"))
      .join(" ");
    const hosts = [...text.matchAll(/"https:\/\/([^/"]+)/g)].map((m) => m[1]).sort();
    expect(hosts).toEqual(ENDPOINTS.map((u) => new URL(u).hostname).sort());
  });
});
