// @vitest-environment node
// M21 B1 (AT-78, D-1218): the server never calls a broker host. No network call of any kind in src/lib/ownerTools/** and
// src/components/ownerTools/**, no broker host in SOURCE_SITES, and politeFetch refuses a host that is not in that table.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_SITES } from "@/lib/http/sourceSites";
import { isRegisteredSourceHost } from "@/lib/http/safeLink";
import { createPoliteFetch, isPoliteFetchRefused } from "@/lib/data/sources/politeFetch.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIRS = ["src/lib/ownerTools", "src/components/ownerTools", "src/app/(app)/(owner-tools)"];
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(tsx|ts|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
};
/** Code only: whole-line and trailing comments are dropped. */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/, ""))
    .join("\n");
const NETWORK =
  /\bfetch\s*\(|\bpoliteFetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|from\s+["'](?:node:)?(?:https?|net|tls|dns)["']|\baxios\b|\bundici\b|\bgot\s*\(/;

describe("no request to a broker host", () => {
  const files = DIRS.flatMap((d) => walk(d));

  it("scans the Owner-tool modules, components and pages", () => {
    expect(files).toContain("src/lib/ownerTools/brokerLinks.ts");
    expect(files).toContain("src/components/ownerTools/BrokerLinks.tsx");
    expect(files).toContain("src/app/(app)/(owner-tools)/holdings/page.tsx");
  });

  it("none of them makes a network call", () => {
    const bad = files.filter((f) =>
      NETWORK.test(code(fs.readFileSync(path.join(ROOT, f), "utf8"))),
    );
    expect(bad).toEqual([]);
  });

  it("self-test: the pattern catches a call", () => {
    for (const s of [
      "await fetch(u)",
      "politeFetch(u)",
      "new XMLHttpRequest()",
      'import h from "node:https"',
    ]) {
      expect(NETWORK.test(s), s).toBe(true);
    }
    expect(NETWORK.test("const prefetch = 1; // fetch(x)")).toBe(true);
    expect(NETWORK.test("brokerUrl(template, ctx)")).toBe(false);
  });

  it("a broker host is not in SOURCE_SITES, so politeFetch's host table refuses it", () => {
    const hosts = JSON.stringify(SOURCE_SITES).toLowerCase();
    for (const h of [
      "broker.example",
      "commsec",
      "selfwealth",
      "stake",
      "interactivebrokers",
      "webull",
    ]) {
      expect(hosts, h).not.toContain(h);
    }
    expect(isRegisteredSourceHost("broker.example")).toBe(false);
  });

  it("politeFetch refuses a broker host before any request is made", async () => {
    const fetchImpl = vi.fn();
    const polite = createPoliteFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gate: () => null,
    });
    const err = await polite
      .fetch("https://broker.example/trade?symbol=ZZA", { source: "anything" })
      .catch((e: unknown) => e);
    expect(isPoliteFetchRefused(err)).toBe(true);
    expect((err as { reason: string }).reason).toBe("host_not_registered");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
