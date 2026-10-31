// Readers for the architecture generator (ARC-001). Each reads one source in the code and returns
// plain data. They read NAMES and STRUCTURE only: the secret reader never sees a value (there is
// none in secretStores.ts) and the host reader keeps only the host part of a literal.
import fs from "node:fs";
import path from "node:path";
import { actionNames, hasUseServer, routeMethods, urlPathFor } from "../ci/route-coverage.mjs";
import { loadSeed } from "../ci/licence-register.mjs";
import { parseYaml } from "./yaml.mjs";

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);
const posix = (p) => p.split(path.sep).join("/");
const exists = (p) => fs.existsSync(p);
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out.sort();
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;

/** Pages (page.tsx), route handlers (route.ts) and server actions under src. */
export function readRoutes(root) {
  const appDir = path.join(root, "src", "app");
  const pages = [];
  const routes = [];
  const actions = [];
  for (const file of walk(path.join(root, "src"))) {
    if (!SOURCE_RE.test(file)) continue;
    const rel = posix(path.relative(root, file));
    const base = path.basename(file);
    const inApp = file.startsWith(appDir + path.sep);
    const dir = inApp ? posix(path.relative(appDir, path.dirname(file))) : "";
    if (inApp && /^page\.(tsx|ts|jsx|js)$/.test(base)) {
      pages.push({ url: urlPathFor(dir), file: rel });
    } else if (inApp && /^route\.(ts|js|mjs|tsx|jsx)$/.test(base)) {
      const url = urlPathFor(dir);
      for (const method of routeMethods(fs.readFileSync(file, "utf8"))) {
        routes.push({ method, url, file: rel });
      }
    } else if (hasUseServer(fs.readFileSync(file, "utf8"))) {
      for (const name of actionNames(fs.readFileSync(file, "utf8"))) {
        actions.push({ name, file: rel });
      }
    }
  }
  return { pages, routes, actions };
}

// ---- workflows ----

/** name, triggers, crons and job ids of every .github/workflows/*.yml, plus the secret names used. */
export function readWorkflows(root) {
  const dir = path.join(root, ".github", "workflows");
  if (!exists(dir)) return [];
  const out = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const y = parseYaml(text) ?? {};
    const on = y.on ?? y.true ?? null; // YAML 1.1 reads a bare `on` key as true
    const triggers =
      on === null ? [] : typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
    const sched = on && typeof on === "object" && !Array.isArray(on) ? on.schedule : null;
    const crons = Array.isArray(sched)
      ? sched.map((s) => String(s?.cron ?? "")).filter(Boolean)
      : [];
    const jobs = y.jobs && typeof y.jobs === "object" ? Object.keys(y.jobs).sort() : [];
    const secrets = [
      ...new Set([...text.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])),
    ].sort();
    out.push({
      file: `.github/workflows/${f}`,
      key: f.replace(/\.ya?ml$/, ""),
      name: typeof y.name === "string" ? y.name : f,
      triggers: [...triggers].sort(),
      crons,
      jobs,
      secrets,
    });
  }
  return out;
}

// ---- migrations ----

function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const CONSTRAINT_START = /^(primary|foreign|unique|check|constraint)\b/i;

/** Tables (with column names and index names) from the `-- +up` part of every migration, in order. */
export function readTables(root) {
  const tables = new Map(); // "db.name" -> { db, name, columns, indexes, migration }
  for (const db of ["main", "auth"]) {
    const dir = path.join(root, "db", "migrations", db);
    if (!exists(dir)) continue;
    for (const f of fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const up = fs.readFileSync(path.join(dir, f), "utf8").split(/^-- \+down/m)[0];
      const sql = up
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      const key = (n) => `${db}.${n}`;
      for (const m of sql.matchAll(
        /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi,
      )) {
        const open = sql.indexOf("(", m.index + m[0].length);
        let depth = 0;
        let end = open;
        for (; end < sql.length; end += 1) {
          if (sql[end] === "(") depth += 1;
          else if (sql[end] === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const columns =
          open < 0
            ? []
            : splitTop(sql.slice(open + 1, end))
                .map((p) => p.trim().split(/\s+/)[0]?.replace(/["`]/g, ""))
                .filter((c) => c && !CONSTRAINT_START.test(c));
        tables.set(key(m[1]), { db, name: m[1], columns, indexes: [], migration: f });
      }
      for (const m of sql.matchAll(
        /\bALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+["`]?(\w+)/gi,
      )) {
        tables.get(key(m[1]))?.columns.push(m[2]);
      }
      for (const m of sql.matchAll(
        /\bALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)/gi,
      )) {
        const t = tables.get(key(m[1]));
        if (t) {
          tables.delete(key(m[1]));
          tables.set(key(m[2]), { ...t, name: m[2] });
        }
      }
      for (const m of sql.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)/gi))
        tables.delete(key(m[1]));
      for (const m of sql.matchAll(
        /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s+ON\s+["`]?(\w+)/gi,
      )) {
        tables.get(key(m[2]))?.indexes.push(m[1]);
      }
      for (const m of sql.matchAll(/\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)/gi)) {
        for (const t of tables.values()) t.indexes = t.indexes.filter((i) => i !== m[1]);
      }
    }
  }
  return [...tables.values()]
    .map((t) => ({
      ...t,
      columns: [...new Set(t.columns)],
      indexes: [...new Set(t.indexes)].sort(),
    }))
    .sort((a, b) => (a.db + a.name < b.db + b.name ? -1 : 1));
}

// ---- Worker slot table (worker/src/schedule.ts) ----

function matchingBrace(text, open) {
  let depth = 0;
  let q = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === "\\") i += 1;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const strProp = (body, name) => {
  const m = new RegExp(`\\b${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
  return m ? m[1] : null;
};

/** Slots of AU_SLOTS and the dispatchable workflow list. */
export function readSlots(root) {
  const rel = "worker/src/schedule.ts";
  if (!exists(path.join(root, rel))) return { slots: [], dispatchable: [] };
  const text = read(root, rel);
  const slots = [];
  const head = /\bslot\(\{/g;
  for (const m of text.matchAll(head)) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(text, open);
    if (close < 0) continue;
    const body = text.slice(open, close + 1);
    const id = strProp(body, "id");
    if (!id) continue; // the helper's own definition
    const wf = /\bworkflow:\s*(?:"([^"]+)"|null)/.exec(body);
    slots.push({
      id,
      time: strProp(body, "time"),
      until: strProp(body, "until"),
      everyMin: /\beveryMin:\s*(\d+)/.exec(body)?.[1] ?? null,
      runner: strProp(body, "runner"),
      route: strProp(body, "route"),
      workflow: wf?.[1] ?? null,
      enabled: /\benabled:\s*true\b/.test(body),
      note: strProp(body, "note") ?? "",
    });
  }
  const dm = /DISPATCHABLE_WORKFLOWS[^=]*=\s*\[([^\]]*)\]/.exec(text);
  const dispatchable = dm ? [...dm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  return { slots: slots.sort((a, b) => (a.id < b.id ? -1 : 1)), dispatchable };
}

// ---- LLM roles (src/lib/llm/budget.ts ROLES, roster.ts ROSTER) ----

export function readLlm(root) {
  const bud = "src/lib/llm/budget.ts";
  const ros = "src/lib/llm/roster.ts";
  let roles = [];
  if (exists(path.join(root, bud))) {
    const m = /\bROLES[^=]*=\s*\[([^\]]*)\]/.exec(read(root, bud));
    roles = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  }
  const roster = [];
  if (exists(path.join(root, ros))) {
    const text = read(root, ros);
    const start = text.indexOf("export const ROSTER");
    for (const m of text
      .slice(start < 0 ? 0 : start)
      .matchAll(/\bprovider:\s*"([^"]+)",\s*modelId:\s*"([^"]+)",\s*roles:\s*\[([^\]]*)\]/g)) {
      roster.push({
        provider: m[1],
        modelId: m[2],
        roles: [...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
      });
    }
  }
  return { roles: [...new Set(roles)].sort(), roster };
}

// ---- licence register ----

export function readSources(root) {
  if (!exists(path.join(root, "db", "migrations", "main"))) return [];
  return loadSeed(root)
    .map((r) => ({
      id: r.source,
      permittedUse: String(r.permitted_use ?? ""),
      risk: String(r.risk ?? ""),
      status: String(r.status ?? ""),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---- secret names and stores (src/lib/security/secretStores.ts), names only ----

const STORE_OF = { G: "github-env", V: "vercel-env", W: "cloudflare-worker" };

export function readSecrets(root) {
  const rel = "src/lib/security/secretStores.ts";
  if (!exists(path.join(root, rel))) return [];
  const text = read(root, rel);
  const consts = {};
  for (const m of text.matchAll(/^const\s+(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) consts[m[1]] = m[2];
  for (const m of text.matchAll(/^const\s+(\w+)\s*=\s*"(\w+)"\s+as\s+const/gm)) consts[m[1]] = m[2];
  const holder = (expr) => {
    const e = expr.trim();
    if (/^\w+$/.test(e)) return consts[e] ?? e;
    const gh = /^GH\(\s*"([^"]+)"\s*\)$/.exec(e);
    if (gh) return `GitHub environment \`${gh[1]}\``;
    return e.replace(/^"|"$/g, "");
  };
  const body = text.slice(text.indexOf("export const SECRET_ROWS"));
  const byName = new Map();
  const slotRe =
    /env:\s*"(production|staging)",\s*store:\s*(\w+),\s*holder:\s*([^\n]+?),\s*names:\s*\[([^\]]*)\]/g;
  for (const m of body.matchAll(slotRe)) {
    const store = STORE_OF[m[2]] ?? consts[m[2]] ?? m[2];
    for (const n of m[4].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) {
      const e = byName.get(n[1]) ?? { name: n[1], stores: [] };
      const s = { env: m[1], store, holder: holder(m[3]) };
      if (!e.stores.some((x) => x.env === s.env && x.store === s.store && x.holder === s.holder))
        e.stores.push(s);
      byName.set(n[1], e);
    }
  }
  return [...byName.values()]
    .map((s) => ({
      ...s,
      stores: s.stores.sort((a, b) => (a.env + a.holder < b.env + b.holder ? -1 : 1)),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- external hosts (D-364: every https:// host literal in non-test source) ----

const TEST_FILE = /(\.test\.|\.spec\.|[\\/]__tests__[\\/]|[\\/]tests?[\\/])/;

/** Map<host, sorted files> from src and worker/src (test files excluded). */
export function readHosts(root, testOnlyHosts = []) {
  const skip = new Set(testOnlyHosts);
  const hosts = new Map();
  for (const base of ["src", "worker/src"]) {
    for (const file of walk(path.join(root, base))) {
      if (!SOURCE_RE.test(file) || TEST_FILE.test(file) || file.endsWith(".d.ts")) continue;
      const rel = posix(path.relative(root, file));
      const code = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .map((l) => l.replace(/(^|\s)\/\/\s.*$/, "$1"))
        .join("\n");
      for (const m of code.matchAll(/https:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
        const host = m[1].toLowerCase().replace(/\.+$/, "");
        if (skip.has(host)) continue;
        if (!hosts.has(host)) hosts.set(host, new Set());
        hosts.get(host).add(rel);
      }
    }
  }
  return new Map(
    [...hosts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([h, f]) => [h, [...f].sort()]),
  );
}
