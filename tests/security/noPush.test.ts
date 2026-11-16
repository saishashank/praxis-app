// @vitest-environment node
// M21 P1 (PLT-079, D-1231, D-1280): web push is not built. No push subscription, no notification permission
// request and no notification display anywhere in src/ or public/. E-mail stays the alert channel.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
};
const FILES = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "public"))];
const FORBIDDEN = [
  /\bPushManager\b/,
  /\bpushManager\b/,
  /applicationServerKey/,
  /\bshowNotification\b/,
  /\bNotification\s*\.\s*requestPermission\b/,
  /\bnew\s+Notification\s*\(/,
  /addEventListener\(\s*["']push["']/,
];

describe("no web push", () => {
  it("scans the app and the public folder, the service worker included", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.endsWith(path.join("public", "sw.js")))).toBe(true);
  });
  it("finds no push subscription, permission request or notification call", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
    }
    expect(hits).toEqual([]);
  });
  it("keeps the switch off: its validator refuses on", async () => {
    const { CONFIG_KEYS } = await import("@/lib/config/keys");
    expect(CONFIG_KEYS.pwa_push_enabled.default).toBe("off");
    expect(await CONFIG_KEYS.pwa_push_enabled.validate("on")).toMatch(/not built/);
  });
});
