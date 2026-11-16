// @vitest-environment node
// M21 P1 (PLT-079, D-1231): the web manifest is static, same-origin and public.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { isPublicPath } from "@/lib/http/gate";
import { KNOWN_ROUTE_PATTERNS } from "@/lib/http/appRoutes.generated";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("manifest", () => {
  const m = manifest();
  it("is an installable standalone app starting at /", () => {
    expect(m.name).toBe("Praxis");
    expect(m.short_name).toBe("Praxis");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it("lists the two brand icons, and the files exist", () => {
    const srcs = (m.icons ?? []).map((i) => i.src).sort();
    expect(srcs).toEqual(["/brand/praxis-app-icon-192.png", "/brand/praxis-app-icon-512.png"]);
    for (const i of m.icons ?? []) {
      expect(i.type).toBe("image/png");
      expect(fs.existsSync(path.join(ROOT, "public", i.src))).toBe(true);
    }
    expect((m.icons ?? []).map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
  });
  it("uses only same-origin relative URLs and says nothing about push", () => {
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/gcm_sender_id|push/i);
  });
  it("is reachable without a session and is a known route", () => {
    expect(isPublicPath("/manifest.webmanifest")).toBe(true);
    expect(isPublicPath("/sw.js")).toBe(true);
    const known = JSON.stringify(KNOWN_ROUTE_PATTERNS);
    expect(known).toContain("/manifest.webmanifest");
    expect(known).toContain("/sw.js");
  });
});
