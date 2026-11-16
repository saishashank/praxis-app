// @vitest-environment node
// M21 P1 (PLT-078, D-1230): the self-check compares APP_BASE_URL's host with the Owner's public domain.
import { describe, expect, it } from "vitest";
import { appBaseUrl, runSelfChecks, type Env } from "@/lib/selfcheck/checks";

const f = (async () => new Response("{}")) as unknown as typeof fetch;
const base = (url: string): Env => ({ APP_BASE_URL: url });

describe("APP_BASE_URL with no public domain (unchanged)", () => {
  it("accepts a vercel.app host and refuses a custom host", async () => {
    expect((await appBaseUrl(base("https://praxis-x.vercel.app"), f)).ok).toBe(true);
    expect((await appBaseUrl(base("https://praxis.example.com"), f)).ok).toBe(false);
    expect((await appBaseUrl(base("https://praxis.example.com"), f, { publicDomain: "" })).ok).toBe(
      false,
    );
  });
});

describe("APP_BASE_URL with a public domain set", () => {
  const ctx = { publicDomain: "praxis.example.com" };
  it("passes only when the host equals the domain", async () => {
    const ok = await appBaseUrl(base("https://praxis.example.com"), f, ctx);
    expect(ok.ok).toBe(true);
    const mixed = await appBaseUrl(base("https://Praxis.Example.com/"), f, ctx);
    expect(mixed.ok).toBe(true);
  });
  it("fails on the old vercel.app host, naming the problem in plain words", async () => {
    const r = await appBaseUrl(base("https://praxis-x.vercel.app"), f, ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("host differs from the public domain");
  });
  it("still needs https, no path, no port, no credentials", async () => {
    for (const bad of [
      "http://praxis.example.com",
      "https://praxis.example.com/app",
      "https://praxis.example.com:8443",
      `https://u:p${"@"}praxis.example.com`,
      "https://praxis.example.com/?a=1",
    ]) {
      expect((await appBaseUrl(base(bad), f, ctx)).ok).toBe(false);
    }
  });
  it("never puts a host name in the detail", async () => {
    for (const url of ["https://praxis.example.com", "https://praxis-x.vercel.app"]) {
      const r = await appBaseUrl(base(url), f, ctx);
      expect(r.detail).not.toMatch(/example|vercel/);
    }
  });
  it("is missing or malformed exactly as before", async () => {
    expect((await appBaseUrl({}, f, ctx)).detail).toBe("missing");
    expect((await appBaseUrl(base("not a url"), f, ctx)).detail).toBe("malformed");
  });
});

describe("runSelfChecks passes the domain through", () => {
  const AGE = "age1" + "q".repeat(58);
  const env = (url: string): Env => ({ APP_BASE_URL: url, BACKUP_PUBLIC_KEY: AGE });
  const line = (r: Awaited<ReturnType<typeof runSelfChecks>>) =>
    r.results.find((x) => x.name === "APP_BASE_URL format");
  it("a vercel.app host passes with no domain and fails once a different domain is set", async () => {
    const e = env("https://praxis-x.vercel.app");
    expect(line(await runSelfChecks(e, f))?.ok).toBe(true);
    expect(line(await runSelfChecks(e, f, { publicDomain: "praxis.example.com" }))?.ok).toBe(false);
  });
});
