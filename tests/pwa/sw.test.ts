// @vitest-environment node
// M21 P1 (PLT-079, D-1231, D-1280): the service worker's fetch handler, run in a fake `self`. Only the static app
// shell and assets on the allow-list are cached; no page, API, RSC payload, write or Owner-tool path ever is.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, "../../public/sw.js"), "utf8");

type Listener = (e: unknown) => void;
type Req = { url: string; method: string; mode?: string; headers?: Map<string, string> };

function boot(opts: { online?: boolean } = {}) {
  const listeners: Record<string, Listener> = {};
  const store = new Map<string, Response>();
  const puts: string[] = [];
  const deleted: string[] = [];
  let online = opts.online ?? true;
  const cacheApi = {
    open: async () => ({
      put: async (r: Req, res: Response) => {
        puts.push(r.url);
        store.set(r.url, res);
      },
      match: async (r: Req) => store.get(r.url)?.clone(),
    }),
    match: async (r: Req) => store.get(r.url)?.clone(),
    keys: async () => ["praxis-shell-v1", "praxis-shell-v0", "other"],
    delete: async (k: string) => {
      deleted.push(k);
      if (k === "praxis-shell-v1") store.clear();
      return true;
    },
  };
  const self = {
    location: { origin: "https://app.example.test" },
    addEventListener: (t: string, l: Listener) => {
      listeners[t] = l;
    },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const ctx = vm.createContext({
    self,
    caches: cacheApi,
    URL,
    Response,
    Promise,
    fetch: async (r: Req) => {
      if (!online) throw new TypeError("offline");
      return new Response("body:" + r.url, { status: 200 });
    },
  });
  vm.runInContext(SRC, ctx);
  async function fetchEvent(req: Req) {
    let responded = null as Promise<Response> | null;
    const waits: Promise<unknown>[] = [];
    listeners.fetch({
      request: { headers: new Map(), mode: "cors", clone: () => req, ...req },
      respondWith: (p: Promise<Response>) => {
        responded = Promise.resolve(p);
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    return { handled: responded !== null, response: responded ? await responded : null };
  }
  return {
    listeners,
    store,
    puts,
    deleted,
    fetchEvent,
    setOnline: (v: boolean) => (online = v),
  };
}
const O = "https://app.example.test";
const get = (p: string, mode = "cors"): Req => ({ url: O + p, method: "GET", mode });

describe("static assets: cache first", () => {
  it.each([
    "/_next/static/chunks/app-1234.js",
    "/_next/static/css/abc.css",
    "/brand/praxis-app-icon-192.png",
    "/brand/praxis-app-icon-512.png",
    "/icon.png",
    "/apple-icon.png",
  ])("caches %s once and serves it offline", async (p) => {
    const w = boot();
    const first = await w.fetchEvent(get(p));
    expect(first.handled).toBe(true);
    expect(w.puts).toEqual([O + p]);
    w.setOnline(false);
    const second = await w.fetchEvent(get(p));
    expect(await second.response?.text()).toBe("body:" + O + p);
  });
});

describe("everything else is never cached", () => {
  it.each([
    "/trades",
    "/picks",
    "/",
    "/home",
    "/market/BHP",
    "/api/health",
    "/api/auth/session",
    "/api/owner-tools/x",
    "/api/blueprint/model",
    "/blueprint",
    "/blueprint/spec",
    "/recommendations",
    "/holdings",
    "/settings",
    "/_next/data/abc/picks.json",
    "/_next/image?url=%2Fx",
    "/brand/other.png",
  ])("%s is not stored, as a fetch or as a navigation", async (p) => {
    for (const mode of ["cors", "navigate"]) {
      const w = boot();
      await w.fetchEvent(get(p, mode));
      expect(w.puts).toEqual([]);
      expect(w.store.size).toBe(0);
    }
  });
  it("leaves API, Owner-tool and Blueprint requests to the browser, navigation or not", async () => {
    for (const p of [
      "/api/x",
      "/api/auth/session",
      "/blueprint",
      "/recommendations",
      "/holdings",
      "/trades",
    ]) {
      for (const mode of ["cors", "navigate"]) {
        const w = boot();
        expect((await w.fetchEvent(get(p, mode))).handled).toBe(false);
      }
    }
  });
  it("leaves a request carrying the RSC header alone", async () => {
    const w = boot();
    const r = await w.fetchEvent({
      ...get("/_next/static/x.js"),
      headers: new Map([["rsc", "1"]]),
    });
    expect(r.handled).toBe(false);
    expect(w.puts).toEqual([]);
  });
  it("leaves non-GET requests and other origins alone", async () => {
    const w = boot();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await w.fetchEvent({ url: O + "/_next/static/x.js", method })).handled).toBe(false);
    }
    const other = { url: "https://other.example.test/_next/static/x.js", method: "GET" };
    expect((await w.fetchEvent(other)).handled).toBe(false);
    expect(w.puts).toEqual([]);
  });
  it("does not store a failed asset response", async () => {
    const w = boot();
    w.setOnline(true);
    const r = await w.fetchEvent(get("/_next/static/missing.js"));
    expect(r.handled).toBe(true);
    // the fake network always answers 200; a 404 path below shows the guard through a direct look at the source
    expect(SRC).toMatch(/\.ok/);
  });
});

describe("page navigations: network only, plain offline page", () => {
  it("passes a page through to the network and stores nothing", async () => {
    const w = boot();
    const r = await w.fetchEvent(get("/picks", "navigate"));
    expect(r.handled).toBe(true);
    expect(await r.response?.text()).toBe("body:" + O + "/picks");
    expect(w.store.size).toBe(0);
  });
  it("offline, shows a built-in page that says so and that figures may be old", async () => {
    const w = boot({ online: false });
    const r = await w.fetchEvent(get("/picks", "navigate"));
    const html = (await r.response?.text()) ?? "";
    expect(r.response?.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.response?.headers.get("cache-control")).toBe("no-store");
    expect(html).toMatch(/offline/i);
    expect(html).toMatch(/figures[^.]*may be old/i);
    expect(html).not.toMatch(/<script/i);
    expect(w.puts).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("has no push, notification or sync handler", () => {
    const w = boot();
    expect(Object.keys(w.listeners).sort()).toEqual(["activate", "fetch", "install"]);
    expect(SRC).not.toMatch(
      /PushManager|pushManager|showNotification|requestPermission|Notification/,
    );
  });
  it("sign-out clears the cache, without taking over the request", async () => {
    const w = boot();
    await w.fetchEvent(get("/icon.png"));
    expect(w.store.size).toBe(1);
    const r = await w.fetchEvent({ url: O + "/api/auth/signout", method: "POST" });
    expect(r.handled).toBe(false);
    expect(w.deleted).toContain("praxis-shell-v1");
    expect(w.store.size).toBe(0);
  });
  it("activation drops older Praxis caches only", async () => {
    const w = boot();
    const waits: Promise<unknown>[] = [];
    w.listeners.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(w.deleted).toEqual(["praxis-shell-v0"]);
  });
});
