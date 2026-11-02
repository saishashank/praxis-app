// @vitest-environment node
// V1-I14 / D-788: "every Owner-only writer audits" as a static test, not only a review rule.
// Every server action and route handler gated by the "admin" permission must reach an audit helper
// (audit / auditTx / audited / appendAudit / appendAuditTx): directly, or through the service
// modules it imports (followed transitively, never through the guard, the session or the audit
// modules themselves, whose own audit call is the 403 refusal, not the write).
// An entry that really does not write is allow-listed below WITH a reason. A new Owner-only action
// or route that audits nothing fails this test.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");

/** "<relative file>#<function>" (actions) or "<relative file>" (route) -> why it needs no audit row. */
const NO_AUDIT: Record<string, string> = {
  "src/app/(app)/reviews/[date]/actions.ts#markReviewReadAction":
    "marks the Owner's own evening review as read: a read receipt on the Owner's own row, not a state change of the system (EML-036)",
};

const AUDIT_CALL = /(?<![.\w])(?:audit|auditTx|audited|appendAudit|appendAuditTx)\s*\(/;
// The 403 path of the guards audits too; following them would make every entry look audited.
const BARRIER = /^src\/lib\/(?:auth\/(?:guard|session|audit|blueprintGuard)|db\/audit)\.tsx?$/;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const read = (f: string) => fs.readFileSync(f, "utf8");
// Drop comments so a word in prose cannot satisfy or trigger a rule.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

type Imp = { names: string[]; file: string };
function importsOf(file: string, text: string): Imp[] {
  const out: Imp[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const target = resolveImport(file, m[2]);
    if (!target) continue;
    const names = [...m[1].matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((x) => x[0])
      .filter((n) => !["type", "as", "default"].includes(n));
    out.push({ names, file: target });
  }
  return out;
}

// DEPTH 0 = the imported module itself; a module that only delegates to a further module is
// followed one more level (DEPTH 1), no further: a long chain is how an unrelated audit call
// somewhere far away would make an unaudited writer look covered.
const MAX_DEPTH = 1;
function reachesAudit(file: string, depth = 0): boolean {
  if (BARRIER.test(rel(file))) return false;
  const text = strip(read(file));
  if (AUDIT_CALL.test(text)) return true;
  if (depth >= MAX_DEPTH) return false;
  return importsOf(file, text).some((imp) => reachesAudit(imp.file, depth + 1));
}

function entryAudits(file: string, body: string, fileText: string): boolean {
  if (AUDIT_CALL.test(body)) return true;
  for (const imp of importsOf(file, fileText)) {
    if (!imp.names.some((n) => new RegExp(`(?<![\w$])${n.replace("$", "\$")}(?![\w$])`).test(body)))
      continue;
    if (reachesAudit(imp.file)) return true;
  }
  return false;
}

type Entry = { id: string; file: string; body: string; text: string };

function entries(): Entry[] {
  const out: Entry[] = [];
  for (const file of walk(path.join(SRC, "app")).sort()) {
    const base = path.basename(file);
    if (!/\.(ts|tsx)$/.test(base)) continue;
    const text = strip(read(file));
    if (/^route\.ts$/.test(base)) {
      if (/withAuth(?:<[^>]*>)?\(\s*"admin"/.test(text))
        out.push({ id: rel(file), file, body: text, text });
    } else if (/^"use server"/m.test(read(file)) || /actions\.tsx?$/.test(base)) {
      // one entry per exported async function whose body asks for the admin permission
      const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
      const starts = [...text.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }));
      starts.forEach((s, i) => {
        const body = text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length);
        if (/requireUser\(\s*"admin"/.test(body)) {
          out.push({ id: `${rel(file)}#${s.name}`, file, body, text });
        }
      });
    }
  }
  return out;
}

describe("every Owner-only writer audits (V1-I14)", () => {
  const all = entries();

  it("finds the Owner-only entry points (the scan is not vacuous)", () => {
    expect(all.length).toBeGreaterThanOrEqual(25);
    const ids = all.map((e) => e.id);
    expect(ids.some((i) => i.includes("users/actions.ts#"))).toBe(true);
    expect(ids.some((i) => i.includes("config/actions.ts#"))).toBe(true);
    expect(ids.some((i) => i.includes("api/learning/challengers"))).toBe(true);
  });

  it("each reaches an audit helper or is allow-listed with a reason", () => {
    const missing = all
      .filter((e) => !(e.id in NO_AUDIT) && !entryAudits(e.file, e.body, e.text))
      .map((e) => e.id);
    expect(missing).toEqual([]);
  });

  it("the allow-list holds only real entries and every reason is written out", () => {
    const ids = new Set(all.map((e) => e.id));
    for (const [id, why] of Object.entries(NO_AUDIT)) {
      expect(ids.has(id), `${id} is not an Owner-only entry any more`).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it("the detector itself: a body with no audit path is flagged", () => {
    const fake = path.join(SRC, "app", "(app)", "users", "actions.ts");
    expect(entryAudits(fake, "await somethingElse();", strip(read(fake)))).toBe(false);
    expect(entryAudits(fake, "await audit(db, env, meta, {});", "")).toBe(true);
  });
});
