// @vitest-environment node
// Licence engine (M22 E1; KB-083, D-1430): sources of an expert, the terms reader, the status rules and one
// source's check against fixture robots and terms pages. No network: the fetch is a table.
import { describe, expect, it } from "vitest";
import {
  checkSource,
  PLATFORM_SITES,
  decideStatus,
  readTerms,
  sourcesOf,
  type LicenceStatus,
  type Robots,
  type Summarisation,
} from "@/lib/experts/licence/engine.mjs";
import { parseRobots, robotsAllows } from "@/lib/kb/fetchRules";
import {
  fixtureFetch,
  noSleep,
  ROBOTS_ALLOW,
  ROBOTS_DENY,
  ROBOTS_DENY_PRAXIS,
  TERMS_FORBID,
  TERMS_PERMIT,
  TERMS_SILENT,
} from "./helpers";

// a manual-only host, spelled in pieces so that no real address appears as a fixture URL (D-521)
const LI = ["https:", "www.linkedin.com"].join("//");
const SITE = "https://zz1.example.test";
const site = () => sourcesOf({ homeUrls: [`${SITE}/home`] })[0]!;

describe("sourcesOf", () => {
  it("lists platform:handle and the URL origin, once each, https only", () => {
    const s = sourcesOf({
      platforms: ["youtube", "own_site"],
      handles: { youtube: "zz-h1" },
      homeUrls: [`${SITE}/home`, `${SITE}/other`, "http://zz9.example.test/x", "not a url"],
    });
    expect(s.map((x) => x.key)).toEqual(["youtube:zz-h1", SITE]);
    expect(s[0]).toMatchObject({
      kind: "platform",
      manual: false,
      origin: PLATFORM_SITES.youtube!.origin,
    });
    expect(s[1]).toMatchObject({ kind: "site", manual: false, origin: SITE, path: "/home" });
  });

  it("marks manual-only platforms and hosts, and a platform with no known feed has no origin", () => {
    const s = sourcesOf({
      handles: { x: "zz1", instagram: "zz2", substack: "zz3" },
      homeUrls: [`${LI}/in/zz`],
    });
    expect(s.map((x) => [x.key, x.manual, x.origin])).toEqual([
      ["x:zz1", true, null],
      ["instagram:zz2", true, null],
      ["substack:zz3", false, null],
      [LI, true, LI],
    ]);
  });

  it("drops a key longer than the column and caps the list", () => {
    const long = `https://${"a".repeat(70)}.example.test`;
    expect(sourcesOf({ homeUrls: [long] })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `https://zz${i}.example.test/`);
    expect(sourcesOf({ homeUrls: many })).toHaveLength(10);
  });
});

describe("readTerms", () => {
  it("a forbidding clause is no, a permitting clause is yes, silence is unknown", () => {
    expect(readTerms(TERMS_FORBID)).toBe("no");
    expect(readTerms(TERMS_PERMIT)).toBe("yes");
    expect(readTerms(TERMS_SILENT)).toBe("unknown");
  });
  it("a forbidding clause wins over a permitting one", () => {
    expect(readTerms(`${TERMS_PERMIT} ${TERMS_FORBID}`)).toBe("no");
  });
  it("reads the words, not the markup or scripts", () => {
    expect(readTerms("<script>you may not scrape</script><p>hello</p>")).toBe("unknown");
  });
});

describe("decideStatus (D-1430)", () => {
  const cases: [Robots, Summarisation, LicenceStatus | null, LicenceStatus][] = [
    ["disallows", "yes", null, "no"],
    ["disallows", "unknown", "enabled", "no"],
    ["allows", "no", null, "no"],
    ["absent", "no", "enabled", "no"],
    ["allows", "yes", null, "enabled"],
    ["allows", "unknown", null, "enabled"], // titles and links only
    ["absent", "unknown", "no", "enabled"],
    ["unreachable", "unknown", null, "unchecked"],
    ["unreachable", "unknown", "enabled", "enabled"],
    ["unreachable", "unknown", "no", "no"],
    ["unreachable", "unknown", "owner-accepted-risk", "owner-accepted-risk"],
    ["allows", "unknown", "owner-accepted-risk", "owner-accepted-risk"],
    ["allows", "yes", "owner-accepted-risk", "owner-accepted-risk"],
    ["disallows", "unknown", "owner-accepted-risk", "no"],
    ["allows", "no", "owner-accepted-risk", "no"],
  ];
  it.each(cases)("%s / %s / was %s -> %s", (robots, summarisation, previous, want) => {
    expect(decideStatus({ robots, summarisation, previous })).toBe(want);
  });
  it("the job never produces owner-accepted-risk from nothing", () => {
    for (const robots of ["allows", "disallows", "absent", "unreachable"] as const)
      for (const summarisation of ["yes", "no", "unknown"] as const)
        for (const previous of [null, "unchecked", "enabled", "no"] as const)
          expect(decideStatus({ robots, summarisation, previous })).not.toBe("owner-accepted-risk");
  });
});

describe("checkSource", () => {
  it("robots allows and the terms permit summarising", async () => {
    const f = fixtureFetch({
      [`${SITE}/robots.txt`]: { status: 200, text: ROBOTS_ALLOW },
      [`${SITE}/terms`]: { status: 200, text: TERMS_PERMIT },
    });
    expect(await checkSource(site(), { fetch: f.fetch, sleep: noSleep })).toMatchObject({
      robots: "allows",
      summarisation: "yes",
      termsUrl: `${SITE}/terms`,
    });
    expect(f.asked).toEqual([`${SITE}/robots.txt`, `${SITE}/terms`]);
  });

  it("robots disallows the source: nothing else is read", async () => {
    const f = fixtureFetch({ [`${SITE}/robots.txt`]: { status: 200, text: ROBOTS_DENY } });
    expect(await checkSource(site(), { fetch: f.fetch, sleep: noSleep })).toMatchObject({
      robots: "disallows",
      summarisation: "unknown",
      termsUrl: null,
    });
    expect(f.asked).toEqual([`${SITE}/robots.txt`]);
  });

  it("a robots group for our own name is obeyed", async () => {
    const f = fixtureFetch({ [`${SITE}/robots.txt`]: { status: 200, text: ROBOTS_DENY_PRAXIS } });
    const r = await checkSource(site(), { fetch: f.fetch, sleep: noSleep });
    expect(r.robots).toBe("disallows");
  });

  it("no robots file is absent (allowed) and the terms are looked for on the next paths", async () => {
    const f = fixtureFetch({
      [`${SITE}/robots.txt`]: { status: 404 },
      [`${SITE}/terms-of-service`]: { status: 200, text: TERMS_FORBID },
    });
    expect(await checkSource(site(), { fetch: f.fetch, sleep: noSleep })).toMatchObject({
      robots: "absent",
      summarisation: "no",
      termsUrl: `${SITE}/terms-of-service`,
    });
    expect(f.asked).toEqual([`${SITE}/robots.txt`, `${SITE}/terms`, `${SITE}/terms-of-service`]);
  });

  it("an HTML page in place of robots.txt is absent", async () => {
    const f = fixtureFetch({ [`${SITE}/robots.txt`]: { status: 200, text: "<html>hi</html>" } });
    expect((await checkSource(site(), { fetch: f.fetch, sleep: noSleep })).robots).toBe("absent");
  });

  it.each([
    ["a server error", { status: 503 }],
    ["a rate limit", { status: 429 }],
    ["a network failure", "throw" as const],
  ])("%s on robots.txt is unreachable and nothing else is read", async (_n, reply) => {
    const f = fixtureFetch({ [`${SITE}/robots.txt`]: reply });
    expect(await checkSource(site(), { fetch: f.fetch, sleep: noSleep })).toMatchObject({
      robots: "unreachable",
    });
    expect(f.asked).toHaveLength(1);
  });

  it("a terms path that robots disallows is not requested", async () => {
    const f = fixtureFetch({
      [`${SITE}/robots.txt`]: { status: 200, text: "User-agent: *\nDisallow: /terms\n" },
      [`${SITE}/terms`]: { status: 200, text: TERMS_FORBID },
      [`${SITE}/tos`]: { status: 200, text: TERMS_SILENT },
    });
    const r = await checkSource(site(), { fetch: f.fetch, sleep: noSleep });
    expect(f.asked).not.toContain(`${SITE}/terms`);
    expect(f.asked).not.toContain(`${SITE}/terms-of-service`);
    expect(r).toMatchObject({ summarisation: "unknown", termsUrl: `${SITE}/tos` });
  });

  it("a same-site redirect is followed, an off-site redirect is unreachable", async () => {
    const ok = fixtureFetch({
      [`${SITE}/robots.txt`]: { status: 301, location: "https://www.zz1.example.test/robots.txt" },
      "https://www.zz1.example.test/robots.txt": { status: 200, text: ROBOTS_ALLOW },
    });
    expect((await checkSource(site(), { fetch: ok.fetch, sleep: noSleep })).robots).toBe("allows");
    const off = fixtureFetch({
      [`${SITE}/robots.txt`]: {
        status: 302,
        location: "https://elsewhere.example.test/robots.txt",
      },
    });
    expect((await checkSource(site(), { fetch: off.fetch, sleep: noSleep })).robots).toBe(
      "unreachable",
    );
    expect(off.asked).toEqual([`${SITE}/robots.txt`]);
  });

  it("never fetches a manual-only platform or a source with no origin", async () => {
    const f = fixtureFetch({});
    for (const s of sourcesOf({ handles: { x: "zz1", substack: "zz2" } })) {
      expect((await checkSource(s, { fetch: f.fetch, sleep: noSleep })).robots).toBe("unreachable");
    }
    expect(f.asked).toEqual([]);
  });

  it("stops at the request cap", async () => {
    const f = fixtureFetch({ [`${SITE}/robots.txt`]: { status: 200, text: ROBOTS_ALLOW } });
    const r = await checkSource(site(), { fetch: f.fetch, sleep: noSleep, maxRequests: 3 });
    expect(r.requests).toBe(3);
    expect(f.asked).toHaveLength(3);
  });

  it("sends the identifying agent and never a cookie", async () => {
    const seen: Record<string, string>[] = [];
    await checkSource(site(), {
      fetch: async (_u, init) => {
        seen.push(init.headers);
        return { status: 404, headers: { get: () => null }, text: async () => "" };
      },
      sleep: noSleep,
    });
    expect(seen[0]!["user-agent"]).toMatch(/^Praxis\//);
    expect(Object.keys(seen[0]!)).toEqual(["user-agent"]);
  });
});

describe("robots reading agrees with the feed rules", () => {
  const paths = ["/", "/home", "/private/x", "/terms"];
  it.each([ROBOTS_ALLOW, ROBOTS_DENY, ROBOTS_DENY_PRAXIS])(
    "the same answer as fetchRules for %j",
    async (text) => {
      for (const p of paths) {
        const f = fixtureFetch({ [`${SITE}/robots.txt`]: { status: 200, text } });
        const src = { ...site(), path: p };
        const mine = (await checkSource(src, { fetch: f.fetch, sleep: noSleep })).robots;
        const theirs = robotsAllows(parseRobots(text), "Praxis/1.0", p) ? "allows" : "disallows";
        expect(mine).toBe(theirs);
      }
    },
  );
});
