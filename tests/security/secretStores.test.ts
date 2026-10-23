// M8 T13 (HIGH RISK): the secret -> stores table drives the go-live rotation (SEC-017, SEC-021, OPS-037,
// OPS-045; docs/M8_design.md decisions 5, 6, 26). These tests keep it equal to the spec table, the
// workflows, .env.example, the smoke checks and the Owner guide, so a rotation cannot miss a store.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_NAME_LIST } from "@/lib/sentinel/schema";
import {
  EMERGENCY_END,
  EMERGENCY_START,
  NON_ROTATING_SECRET_NAMES,
  ROTATION_END,
  ROTATION_START,
  ROTATION_STEPS,
  SECRET_ROWS,
  allNames,
  expiryKeysWithoutRow,
  positionOf,
  renderEmergencyBlock,
  renderRotationBlock,
  rotationOrder,
  rowsToRotate,
  trackedExpiryKeys,
} from "@/lib/security/secretStores";

const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), "utf8");

/** Row ids of the SEC-017 table in spec/10 (lines that start "| (x) "). */
function specRowIds(): string[] {
  const text = read("spec/10_nfr_testing.md");
  const start = text.indexOf("**Secret → stores table**");
  const end = text.indexOf("The build agent's PAT has **no** access");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const ids: string[] = [];
  for (const line of text.slice(start, end).split("\n")) {
    const m = /^\| \(([a-z0-9-]+)\) /.exec(line);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

const workflowSecretNames = (): Set<string> => {
  const dir = path.join(root, ".github", "workflows");
  const out = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".yml")) continue;
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      out.add(m[1]!);
    }
  }
  return out;
};

const envExampleNames = (): Set<string> =>
  new Set(
    read(".env.example")
      .split("\n")
      .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((x): x is string => !!x),
  );

describe("SEC-017 secret table in code", () => {
  it("SEC-017: every row of the spec table is present, and only the design's extra rows are added", () => {
    const spec = specRowIds();
    expect(spec.length).toBe(19);
    const code = SECRET_ROWS.filter((r) => !r.extra).map((r) => r.id);
    expect([...code].sort()).toEqual([...spec].sort());
    expect(SECRET_ROWS.filter((r) => r.extra).map((r) => r.id)).toEqual(["h-s", "pii"]);
    expect(new Set(SECRET_ROWS.map((r) => r.id)).size).toBe(SECRET_ROWS.length);
  });

  it("SEC-021: the go-live scope is every row (b) to (j), (m), PII_HASH_KEY and the staging Resend key", () => {
    const rotated = rowsToRotate().map((r) => r.id);
    for (const id of [
      "b",
      "b-s",
      "c1",
      "c2",
      "c3",
      "c4",
      "d",
      "e",
      "f",
      "f-r",
      "g",
      "n",
      "h",
      "h-s",
      "i",
      "j",
      "m",
      "pii",
    ]) {
      expect(rotated, id).toContain(id);
    }
    const byId = Object.fromEntries(SECRET_ROWS.map((r) => [r.id, r.handling]));
    expect(byId.a).toBe("revoke");
    expect(byId.k).toBe("keep");
    expect(byId.l).toBe("absent");
  });

  it("every rotated secret has a smoke check or an explicit reason", () => {
    for (const r of rowsToRotate()) {
      if (r.smoke.kind === "check") expect(r.smoke.checks.length, r.id).toBeGreaterThan(0);
      else expect(r.smoke.reason.length, r.id).toBeGreaterThan(20);
    }
    for (const r of SECRET_ROWS.filter((x) => x.handling !== "rotate")) {
      if (r.smoke.kind === "listed") expect(r.smoke.reason.length, r.id).toBeGreaterThan(20);
    }
  });

  it("each named smoke check exists in the code that runs it", () => {
    for (const r of SECRET_ROWS) {
      if (r.smoke.kind !== "check") continue;
      for (const c of r.smoke.checks) {
        expect(fs.existsSync(path.join(root, c.source)), `${r.id} ${c.source}`).toBe(true);
        expect(read(c.source).includes(c.needle), `${r.id}: ${c.name} needle ${c.needle}`).toBe(
          true,
        );
      }
    }
  });

  it("every row names at least one store holder unless it is revoked, and each rotated row has an issuer", () => {
    for (const r of SECRET_ROWS) {
      expect(r.issuer.length, r.id).toBeGreaterThan(5);
      if (r.handling !== "revoke") expect(r.slots.length, r.id).toBeGreaterThan(0);
      for (const s of r.slots) {
        expect(s.names.length, r.id).toBeGreaterThan(0);
        expect(s.holder.length, r.id).toBeGreaterThan(3);
      }
    }
  });

  it("names match .env.example: a GitHub name may only add the _PROD or _STAGING suffix", () => {
    const example = envExampleNames();
    for (const r of SECRET_ROWS) {
      for (const s of r.slots) {
        for (const n of s.names) {
          const base = s.store === "github-env" ? n.replace(/_(PROD|STAGING)$/, "") : n;
          expect(example.has(base), `${r.id}: ${n}`).toBe(true);
        }
      }
    }
  });

  it("names match the workflows: every GitHub-environment name is read by a workflow, and every secret a workflow reads is listed", () => {
    const used = workflowSecretNames();
    const listed = new Set(allNames());
    for (const r of SECRET_ROWS) {
      for (const s of r.slots) {
        if (s.store !== "github-env") continue;
        for (const n of s.names)
          expect(used.has(n), `${r.id}: ${n} not read by any workflow`).toBe(true);
      }
    }
    for (const n of used) {
      expect(
        listed.has(n) || n in NON_ROTATING_SECRET_NAMES,
        `workflow secret ${n} is neither rotated nor listed as not rotated`,
      ).toBe(true);
    }
    for (const n of Object.keys(NON_ROTATING_SECRET_NAMES)) {
      expect(used.has(n) || n === "BACKUP_PUBLIC_KEY", n).toBe(true);
    }
  });

  it("SEC-021: the expiry list is the same list System Health, the Ops checklist and the reminder email read", () => {
    expect(expiryKeysWithoutRow()).toEqual([]);
    expect([...trackedExpiryKeys()].sort()).toEqual([...CREDENTIAL_NAME_LIST].sort());
    for (const r of SECRET_ROWS) {
      if (r.expiry.tracked) expect(CREDENTIAL_NAME_LIST, r.id).toContain(r.expiry.key);
      else expect(r.expiry.why.length, r.id).toBeGreaterThan(20);
    }
  });
});

describe("rotation order (decision 26)", () => {
  const order = rotationOrder();

  it("starts with the revoked token, has contiguous positions and leaves out only (k) and (l)", () => {
    expect(order[0]!.row.id).toBe("a");
    expect(order.map((o) => o.position)).toEqual(order.map((_, i) => i + 1));
    const missing = SECRET_ROWS.filter((r) => !order.some((o) => o.row.id === r.id)).map(
      (r) => r.id,
    );
    expect(missing.sort()).toEqual(["k", "l"]);
    expect(positionOf("k")).toBeNull();
    expect(positionOf("a")).toBe(1);
  });

  it("steps never go backwards, and every production store is done before any staging store", () => {
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]!.step).toBeGreaterThanOrEqual(order[i - 1]!.step);
    }
    for (const r of rowsToRotate()) {
      for (const s of r.slots) {
        expect(
          ROTATION_STEPS.some((x) => x.id === s.step),
          r.id,
        ).toBe(true);
        if (s.env === "production") expect(s.step, `${r.id} ${s.holder}`).toBeLessThanOrEqual(5);
        if (s.env === "staging" && s.store !== "github-env") expect(s.step, r.id).toBe(7);
      }
    }
  });

  it("a value is created before it is copied: GitHub or Turso, then Vercel, then the Worker", () => {
    const rank: Record<string, number> = {
      "github-env": 0,
      "vercel-env": 1,
      "cloudflare-worker": 2,
    };
    for (const r of rowsToRotate()) {
      for (const env of ["production", "staging"] as const) {
        const slots = r.slots.filter((s) => s.env === env);
        for (let i = 1; i < slots.length; i += 1) {
          const a = slots[i - 1]!;
          const b = slots[i]!;
          if (rank[a.store] !== undefined && rank[b.store] !== undefined) {
            expect(rank[b.store], `${r.id} ${env}`).toBeGreaterThanOrEqual(rank[a.store]!);
          }
        }
      }
    }
    const d = SECRET_ROWS.find((r) => r.id === "d")!;
    const gh = d.slots.find((s) => s.env === "production" && s.store === "github-env")!;
    expect(gh.step).toBe(3);
  });
});

describe("no value, no person in the table or the guides (SEC-101, SEC-110)", () => {
  const files = [
    "docs/owner-guide/M8_go_live.md",
    "docs/owner-guide/operations.md",
    "docs/owner-guide/README.md",
  ];
  const text = [
    renderRotationBlock(),
    renderEmergencyBlock(),
    JSON.stringify(SECRET_ROWS),
    ...files.map((f) => (fs.existsSync(path.join(root, f)) ? read(f) : "")),
  ].join("\n");

  it("holds no token-like or key-like string and no email address", () => {
    expect(text).not.toMatch(/\b[0-9a-f]{40,}\b/i);
    expect(text).not.toMatch(
      /\b(ghp_|github_pat_|re_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|AGE-SECRET-KEY|age1[0-9a-z]{20,}|AIza)/,
    );
    expect(text).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/\b[A-Za-z0-9+/]{44,}={0,2}\b/);
  });
});

describe("the Owner guide is generated from the table", () => {
  const guide = "docs/owner-guide/M8_go_live.md";
  const swap = (doc: string, start: string, end: string, block: string): string => {
    const a = doc.indexOf(start);
    const b = doc.indexOf(end);
    if (a < 0 || b < a) throw new Error(`markers ${start} missing in ${guide}`);
    return doc.slice(0, a) + block + doc.slice(b + end.length);
  };

  it("the rotation table and the emergency checklist in the guide equal the generated text", () => {
    let doc = read(guide);
    const wanted = swap(
      swap(doc, ROTATION_START, ROTATION_END, renderRotationBlock()),
      EMERGENCY_START,
      EMERGENCY_END,
      renderEmergencyBlock(),
    );
    if (process.env.PRAXIS_UPDATE_GUIDE === "1" && wanted !== doc) {
      fs.writeFileSync(path.join(root, guide), wanted);
      doc = wanted;
    }
    expect(doc).toBe(wanted);
  });

  it("the guide names every rotated secret row and every step title", () => {
    const doc = read(guide);
    for (const r of rowsToRotate()) expect(doc, r.id).toContain(`(${r.id})`);
    for (const s of ROTATION_STEPS) expect(doc, s.title).toContain(s.title);
  });
});

describe("the secrets tool reads a copy of the table (scripts/secrets/rows.json)", () => {
  const file = "scripts/secrets/rows.json";
  const rowsJson = (): string =>
    `${JSON.stringify(
      SECRET_ROWS.map((r) => ({
        id: r.id,
        title: r.title,
        handling: r.handling,
        issuer: r.issuer,
        expiry: r.expiry.tracked ? { tracked: true, key: r.expiry.key } : { tracked: false },
        slots: r.slots.map((s) => ({
          env: s.env,
          store: s.store,
          holder: s.holder,
          names: s.names,
        })),
      })),
      null,
      2,
    )}\n`;

  // Compared as data, so prettier's layout of the file does not matter.
  it("the copy equals the table (PRAXIS_UPDATE_GUIDE=1 rewrites it)", () => {
    const wanted = rowsJson();
    const full = path.join(root, file);
    const same = (): boolean =>
      fs.existsSync(full) &&
      JSON.stringify(JSON.parse(read(file))) === JSON.stringify(JSON.parse(wanted));
    if (process.env.PRAXIS_UPDATE_GUIDE === "1" && !same()) fs.writeFileSync(full, wanted);
    expect(JSON.parse(read(file))).toEqual(JSON.parse(wanted));
  });
});
