// @vitest-environment node
// M7 T1 / D-130: locks the CSP (SEC-012, design 2.6). Any change to a directive fails here and
// must be a deliberate decision, not a side effect of adding a UI library.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/http/csp";

const PROD = [
  "default-src 'self'",
  "script-src 'self' 'nonce-N' 'strict-dynamic'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

describe("CSP lock", () => {
  it("production policy is exactly the approved text", () => {
    expect(buildCsp("N", false)).toBe(PROD);
  });

  it("development differs only by unsafe-eval and websocket connect", () => {
    const dev = buildCsp("N", true);
    expect(dev).toBe(
      PROD.replace("'strict-dynamic'", "'strict-dynamic' 'unsafe-eval'")
        .replace("connect-src 'self'", "connect-src 'self' ws: wss:")
        .replace("; upgrade-insecure-requests", ""),
    );
  });

  it("production script-src has no unsafe-inline or unsafe-eval", () => {
    const script = buildCsp("N", false)
      .split("; ")
      .find((d) => d.startsWith("script-src"))!;
    expect(script).not.toMatch(/unsafe-(inline|eval)/);
  });

  it("no directive lists an external host except form-action accounts.google.com", () => {
    for (const d of buildCsp("N", false).split("; ")) {
      const hosts = d.match(/https?:\/\/[^\s]+|\*/g) ?? [];
      if (d.startsWith("form-action")) expect(hosts).toEqual(["https://accounts.google.com"]);
      else expect(hosts).toEqual([]);
    }
  });

  it("fonts are self-hosted by next/font: no external font link in the source", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const layout = fs.readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
    expect(layout).toContain("JetBrains_Mono");
    for (const text of [layout, css]) {
      expect(text).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(text).not.toMatch(/@import\s+url\(/);
    }
  });
});
