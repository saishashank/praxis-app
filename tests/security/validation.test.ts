// @vitest-environment node
// SEC-013, M8 T4: malformed, oversized and wrong-type input to the write routes, the signed machine
// routes and every server action is answered with a 4xx / error code and changes nothing. Cases are
// generated from the source tree, so a new route or action is swept automatically. Real migrated
// databases; the Owner is signed in (the strongest role, so a refusal is the validator's, not the guard's).
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/session";
import { addUser, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  actionsOf,
  concreteUrl,
  isAuthJsUrl,
  isMachineUrl,
  ROOT,
  routesOf,
  snapshot,
  surfaces,
} from "./support";

const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: vi.fn(), get: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  forbidden: vi.fn(() => {
    throw new Error("NEXT_FORBIDDEN");
  }),
}));
vi.mock("@/auth", () => ({ signIn: vi.fn(), signOut: vi.fn(), handlers: {}, auth: vi.fn() }));

const BASE = "https://app.example.test";
const CODE = /^[a-z][a-z0-9_]*$/;
const all = surfaces();
const routes = routesOf(all);
const actions = actionsOf(all);
const routeModules = import.meta.glob("../../src/app/api/**/route.ts");
const actionModules = import.meta.glob("../../src/app/**/*{actions,Actions}.ts");
const libActionModules = import.meta.glob("../../src/lib/auth/actions.ts");

type Handler = (req: Request, ctx?: unknown) => Promise<Response> | Response;
const loadRoute = async (file: string) =>
  (await routeModules[`../../${file}`]()) as Record<string, Handler>;

let main: Client;
let auth: Client;
const state = async () => [await snapshot(main), await snapshot(auth)];

beforeAll(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  const id = await addUser(auth, { email: "owner@example.test", role: "owner" });
  mem.user = { id, email: "owner@example.test", name: null, role: "owner" } satisfies CurrentUser;
});
afterAll(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

// ---- write routes ----------------------------------------------------------------------------

// These two routes never read a request body (they act on the path / the signed-in Owner only), so
// body input cannot reach them; they are checked for "ignores the body" instead.
const BODYLESS = new Set([
  "POST /api/email/test",
  "POST /api/learning/challengers/[id]/shadow-viewed",
]);
const writeRoutes = routes.filter(
  (r) => r.method !== "GET" && !isMachineUrl(r.url) && !isAuthJsUrl(r.url),
);
const WRONG_TYPES = JSON.stringify({
  confirm: "yes",
  text: 5,
  reason: {},
  start: 1,
  end: [],
  snooze_until: true,
  subject_kind: 5,
  subject_id: {},
  id: [],
  note: 7,
  family: 3,
  version: "v",
});
const BODIES: Record<string, string> = {
  "malformed JSON": "{not json",
  "truncated JSON": '{"confirm": tru',
  "a JSON array": "[]",
  "a JSON string": '"x"',
  "a JSON number": "123",
  "JSON null": "null",
  "an oversized body (200 kB)": JSON.stringify({ text: "x".repeat(200_000) }),
  "an oversized body (2 MB of padding)": " ".repeat(2_000_000) + "{}",
};
const ctxFor = (over: Record<string, string> = {}) => ({
  params: Promise.resolve({ key: "k", id: "sample-1", family: "f", code: "ABC", ...over }),
});
const call = async (r: (typeof routes)[number], body: string | undefined, ctx = ctxFor()) => {
  const mod = await loadRoute(r.file);
  return mod[r.method](
    new Request(new URL(concreteUrl(r.url), BASE), { method: r.method, body }),
    ctx,
  );
};
const codeOf = async (res: Response) => ((await res.json()) as { error?: unknown }).error;

describe("SEC-013: write routes refuse bad bodies with 400 and a code, and change nothing", () => {
  it("sweeps a realistic number of write routes", () => {
    expect(writeRoutes.length).toBeGreaterThan(15);
  });

  for (const r of writeRoutes.filter((x) => !BODYLESS.has(x.id))) {
    for (const [label, body] of Object.entries(BODIES)) {
      it(`${r.id} -> 400 for ${label}`, async () => {
        const before = await state();
        const res = await call(r, body);
        expect(res.status).toBe(400);
        const code = await codeOf(res);
        expect(code).toMatch(CODE);
        expect(await state()).toEqual(before);
      });
    }

    it(`${r.id} -> a 4xx code for wrong-typed fields, nothing changed`, async () => {
      const before = await state();
      const res = await call(r, WRONG_TYPES);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await codeOf(res)).toMatch(CODE);
      expect(await state()).toEqual(before);
    });
  }

  it("a body-less route that sees the body ignores it (same answer as without)", async () => {
    for (const r of writeRoutes.filter((x) => BODYLESS.has(x.id))) {
      const mod = await loadRoute(r.file);
      expect(fs.readFileSync(path.join(ROOT, r.file), "utf8")).not.toMatch(/\.json\(\)|\.text\(\)/);
      const a = await mod[r.method](
        new Request(new URL(concreteUrl(r.url), BASE), { method: r.method, body: "{not json" }),
        ctxFor(),
      );
      const b = await mod[r.method](
        new Request(new URL(concreteUrl(r.url), BASE), { method: r.method }),
        ctxFor(),
      );
      expect(a.status, r.id).toBe(b.status);
      expect(a.status, r.id).toBeLessThan(500);
    }
  });

  const PARAMS = [
    "",
    "x".repeat(5000),
    "../../etc/passwd",
    "%E0%A4%A",
    "a'; DROP TABLE app_user;--",
    "\u0000",
    "<script>alert(1)</script>",
  ];
  for (const r of writeRoutes.filter((x) => /\[/.test(x.url))) {
    it(`${r.id} -> a 4xx code for hostile path parameters, nothing changed`, async () => {
      for (const p of PARAMS) {
        const before = await state();
        const res = await call(
          r,
          JSON.stringify({ confirm: true }),
          ctxFor({ key: p, id: p, family: p }),
        );
        expect(res.status, JSON.stringify(p)).toBeGreaterThanOrEqual(400);
        expect(res.status, JSON.stringify(p)).toBeLessThan(500);
        expect(await codeOf(res)).toMatch(CODE);
        expect(await state()).toEqual(before);
      }
    });
  }
});

describe("SEC-013: read routes take hostile query strings without an error or a change", () => {
  const reads = routes.filter(
    (r) => r.method === "GET" && !isMachineUrl(r.url) && !isAuthJsUrl(r.url),
  );
  const QUERIES = [
    "?q=" + "x".repeat(50_000),
    "?q=%00%27%22%3Cscript%3E&tier=%E0%A4%A&unacked=maybe&limit=-1",
    "?limit=99999999999999999999&offset=NaN&subject_kind[]=1&history=2",
  ];
  for (const r of reads) {
    it(`GET ${r.url} never answers 5xx or changes state`, async () => {
      const mod = await loadRoute(r.file);
      for (const q of QUERIES) {
        const before = await state();
        const res = await mod.GET(new Request(new URL(concreteUrl(r.url) + q, BASE)), ctxFor());
        expect(res.status, q.slice(0, 40)).toBeLessThan(500);
        expect(await state()).toEqual(before);
      }
    });
  }
});

// ---- signed machine routes ---------------------------------------------------------------------

describe("SEC-013 / SEC-017: signed machine routes refuse unsigned or bad input and change nothing", () => {
  const machine = routes.filter((r) => r.method === "POST" && r.url.startsWith("/api/internal/"));
  const SECRET = "7".repeat(64);
  const env = () => {
    for (const k of ["WORKER_HMAC_SECRET", "ACTIONS_HMAC_SECRET"]) vi.stubEnv(k, SECRET);
  };
  const BAD: Record<string, { body?: string; headers?: Record<string, string> }> = {
    "no signature headers, empty body": {},
    "no signature headers, malformed body": { body: "{not json" },
    "no signature headers, oversized body (5 MB)": { body: "x".repeat(5_000_000) },
    "malformed signature headers": {
      body: "{}",
      headers: {
        "x-praxis-timestamp": "yesterday",
        "x-praxis-nonce": "n",
        "x-praxis-signature": "s",
      },
    },
    "well-formed but wrong signature": {
      body: "{}",
      headers: {
        "x-praxis-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-praxis-nonce": "a".repeat(32),
        "x-praxis-signature": "b".repeat(64),
      },
    },
  };
  it("sweeps the signed routes", () => expect(machine.length).toBeGreaterThanOrEqual(10));

  for (const r of machine) {
    for (const [label, bad] of Object.entries(BAD)) {
      it(`${r.id} -> 401 for ${label}`, async () => {
        env();
        const before = await state();
        const mod = await loadRoute(r.file);
        const out = await mod.POST(
          new Request(new URL(r.url, BASE), {
            method: "POST",
            body: bad.body,
            headers: bad.headers,
          }),
        );
        // An oversized body is refused (400) before the signature is even read.
        expect(out.status).toBe(label.includes("oversized") ? 400 : 401);
        expect(await state()).toEqual(before);
      });
    }
  }

  it("the staging-only test login answers 404 outside staging, before reading the body", async () => {
    vi.stubEnv("PRAXIS_ENV", "production");
    const mod = await loadRoute("src/app/api/test-identity/login/route.ts");
    const before = await state();
    const res = await mod.POST(
      new Request(new URL("/api/test-identity/login", BASE), { method: "POST", body: "{not json" }),
    );
    expect(res.status).toBe(404);
    expect(await state()).toEqual(before);
    vi.unstubAllEnvs();
    vi.stubEnv("PII_HASH_KEY", KEY);
  });
});

// ---- server actions ----------------------------------------------------------------------------

// Form fields of each action: quoted names read from the action file, plus the field lists that
// the settings actions keep in `as const` arrays.
function fieldsOf(file: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/(?:\.get\(|\btext\(fd,|\bfield\(fd,|\(fd,)\s*"(\w+)"/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/\[((?:\s*"[a-z_]+",?)+)\s*\] as const/g)) {
    for (const n of m[1].matchAll(/"([a-z_]+)"/g)) names.add(n[1]);
  }
  return [...names];
}

// The three settings actions share one file but each owns a field list.
const FIELD_OVERRIDE: Record<string, string[]> = {
  updatePreferencesAction: ["time_format", "alert_p1", "alert_p2"],
  updateAppearanceAction: ["theme", "motion"],
  updateRegionAction: ["default_market", "times_in"],
};
// Actions with no form input at all: nothing for a bad input to reach.
const NO_INPUT = new Set([
  "resetAsxTripAction",
  "dismissWelcomeAction",
  "cycleThemeAction",
  "signInAction",
  "signOutAction",
]);
// A checkbox-style field means "on" at any value, so it is left out of the garbage sets.
const CHECKBOX = new Set(["quiet_off"]);
// Per-page settings forms: all fields optional, an empty form is a no-op (bad values still fail).
const NOOP_ON_EMPTY = new Set([
  "updatePreferencesAction",
  "updateAppearanceAction",
  "updateRegionAction",
]);

describe("SEC-013: server actions refuse bad form input with an error code and change nothing", () => {
  const withInput = actions.filter((a) => !NO_INPUT.has(a.name));
  it("sweeps a realistic number of actions with input", () => {
    expect(withInput.length).toBeGreaterThan(25);
  });

  const find = (file: string) => {
    const rel = `../../${file}`;
    const load = actionModules[rel] ?? libActionModules[rel];
    expect(load, file).toBeDefined();
    return load() as Promise<Record<string, (arg: unknown) => Promise<unknown>>>;
  };

  for (const a of withInput) {
    it(`${a.name} -> a code for empty, oversized, control-character, negative, NaN and file input`, async () => {
      const mod = await find(a.file);
      const names = (FIELD_OVERRIDE[a.name] ?? fieldsOf(a.file)).filter((n) => !CHECKBOX.has(n));
      const mk = (v: string | Blob) => {
        const fd = new FormData();
        for (const n of names) fd.set(n, v);
        return fd;
      };
      const inputs: [string, FormData | string][] = [
        ["empty", new FormData()],
        ["oversized", mk("x".repeat(100_000))],
        ["control characters", mk("\u0000'; DROP TABLE app_user;--<script>")],
        ["negative", mk("-1")],
        ["NaN", mk("NaN")],
        ["file", mk(new Blob(["x"]))],
      ];
      for (const [label, fd] of inputs) {
        const before = await state();
        const arg =
          a.name === "setSortPreferenceAction" ? (label === "empty" ? "" : "x".repeat(1000)) : fd;
        const result = (await mod[a.name](arg)) as { ok?: unknown; error?: unknown } | undefined;
        expect(result, `${a.name} ${label}`).toBeTypeOf("object");
        if (label === "empty" && NOOP_ON_EMPTY.has(a.name)) {
          // Every field is optional: nothing to change is a successful no-op, never a write.
          expect(await state()).toEqual(before);
          continue;
        }
        expect(result?.ok, `${a.name} ${label} must not succeed`).toBeUndefined();
        expect(String(result?.error), `${a.name} ${label}`).toMatch(CODE);
        expect(await state(), `${a.name} ${label} changed state`).toEqual(before);
      }
    });
  }

  it("setQuietHoursAction refuses bad times (the 'off' checkbox clears them, by design)", async () => {
    const mod = await find("src/app/(app)/settings/actions.ts");
    for (const v of ["", "25:99", "x".repeat(10_000), "-1", "09:00;DROP", "9:00"]) {
      const fd = new FormData();
      fd.set("quiet_start", v);
      fd.set("quiet_end", v);
      const before = await state();
      const result = (await mod.setQuietHoursAction(fd)) as { ok?: unknown; error?: unknown };
      expect(result.ok).toBeUndefined();
      expect(String(result.error)).toMatch(CODE);
      expect(await state()).toEqual(before);
    }
  });

  it("the settings actions ignore unknown fields and refuse a bad value for a known one", async () => {
    const mod = await find("src/app/(app)/settings/actions.ts");
    for (const [fn, field] of [
      ["updatePreferencesAction", "time_format"],
      ["updateAppearanceAction", "theme"],
      ["updateRegionAction", "default_market"],
    ] as const) {
      const fd = new FormData();
      fd.set(field, "not-a-valid-value");
      fd.set("role", "owner"); // an attempt to write a field that is not this form's
      const before = await state();
      const result = (await mod[fn](fd)) as { ok?: unknown; error?: unknown };
      expect(result.ok, fn).toBeUndefined();
      expect(String(result.error), fn).toMatch(CODE);
      expect(await state()).toEqual(before);
    }
  });

  it("with no session every action redirects to sign-in and changes nothing", async () => {
    const signedIn = mem.user;
    mem.user = null;
    const before = await state();
    for (const a of actions.filter(
      (x) => x.name !== "signInAction" && x.name !== "signOutAction",
    )) {
      const mod = await find(a.file);
      await expect(
        Promise.resolve().then(() =>
          mod[a.name](a.name === "setSortPreferenceAction" ? "name" : new FormData()),
        ),
        a.name,
      ).rejects.toThrow("NEXT_REDIRECT");
    }
    expect(await state()).toEqual(before);
    mem.user = signedIn;
  });
});
