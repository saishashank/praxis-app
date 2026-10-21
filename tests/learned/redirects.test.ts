// @vitest-environment node
// M7 T18: every old /learning path reaches its new /reviews/learned path (decision 57), the old pages are
// gone, the security headers are unchanged, and every page of the area is in the nav model.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig, { learningRedirects } from "../../next.config";
import { matchRoute } from "@/lib/ui/nav";

const root = path.resolve(import.meta.dirname, "..", "..");

/** First rule whose source matches (Next tries rules in order); `:name` is a segment, `:name*` the rest. */
function redirect(url: string): string | null {
  const [p, qs] = url.split("?");
  for (const r of learningRedirects) {
    const names: string[] = [];
    const re = new RegExp(
      "^" +
        r.source
          .replace(/\/:(\w+)\*/g, (_m, n: string) => {
            names.push(n);
            return "(?:/(.*))?";
          })
          .replace(/:(\w+)/g, (_m, n: string) => {
            names.push(n);
            return "([^/]+)";
          }) +
        "/?$",
    );
    const m = re.exec(p!);
    if (!m) continue;
    let dest = r.destination;
    names.forEach((n, i) => {
      dest = dest.replace(new RegExp(`/?:${n}\\*?`), m[i + 1] ? `/${m[i + 1]}` : "");
    });
    return qs ? `${dest}?${qs}` : dest;
  }
  return null;
}

describe("redirects from /learning", () => {
  it.each([
    ["/learning", "/reviews/learned"],
    ["/learning/", "/reviews/learned"],
    ["/learning/lessons/L-1", "/reviews/learned/lessons/L-1"],
    ["/learning/lessons/L%3A1", "/reviews/learned/lessons/L%3A1"],
    ["/learning/challengers/C-AU-F1-2", "/reviews/learned/challengers/C-AU-F1-2"],
    ["/learning/families/F1", "/reviews/learned/families/F1"],
    ["/learning?q=zz", "/reviews/learned?q=zz"],
  ])("%s -> %s", (from, to) => {
    expect(redirect(from)).toBe(to);
  });

  it("are all permanent and none redirects a new path", () => {
    expect(learningRedirects.every((r) => r.permanent)).toBe(true);
    expect(learningRedirects.every((r) => r.source.startsWith("/learning"))).toBe(true);
    expect(redirect("/reviews/learned")).toBeNull();
  });

  it("every destination is a page of the nav model", () => {
    for (const p of [
      "/reviews/learned",
      "/reviews/learned/lessons/x",
      "/reviews/learned/challengers/x",
    ]) {
      expect(matchRoute(p), p).not.toBeNull();
    }
  });

  it("the old pages are gone and nothing links to them", () => {
    expect(fs.existsSync(path.join(root, "src/app/(app)/learning"))).toBe(false);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (
          /\.(tsx?|ts)$/.test(e.name) &&
          /["'`]\/learning(?!\w)/.test(fs.readFileSync(f, "utf8"))
        )
          hits.push(path.relative(root, f));
      }
    };
    walk(path.join(root, "src", "app", "(app)"));
    walk(path.join(root, "src", "components"));
    expect(hits).toEqual([]);
  });

  it("leaves the security headers as they were", async () => {
    const h = await nextConfig.headers!();
    expect(h).toHaveLength(1);
    expect(h[0]!.source).toBe("/:path*");
    expect(h[0]!.headers).toEqual([
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    ]);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
