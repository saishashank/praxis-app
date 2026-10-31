// ARC-001: build docs/architecture/architecture.json from the code and the hand-kept spec map.
//   node scripts/architecture/generate.mjs           write the model
//   node scripts/architecture/generate.mjs --check   exit 1 when the committed file is stale (D-366)
// Zero dependencies. The model holds names and structure only (SEC-113): no secret value, no
// fingerprint, no email. `buildModel(root)` is exported for the CI completeness check (WP3).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readHosts,
  readLlm,
  readRoutes,
  readSecrets,
  readSlots,
  readSources,
  readTables,
  readWorkflows,
} from "./readers.mjs";
import { SCHEMA_VERSION, VIEWS, validateModel } from "./schema.mjs";
import { parseYaml } from "./yaml.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MODEL_PATH = "docs/architecture/architecture.json";
export const SPEC_MAP_PATH = "docs/architecture/spec_map.yaml";

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Glob to RegExp: "*" any run, "?" one char, "{a,b}" alternatives. */
export const globRe = (g) => {
  let out = "";
  let depth = 0;
  for (const c of g) {
    if (c === "{") {
      depth += 1;
      out += "(?:";
    } else if (c === "}" && depth > 0) {
      depth -= 1;
      out += ")";
    } else if (c === "," && depth > 0) out += "|";
    else if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else out += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
};

const DEFAULT_FAILURE = {
  service: "Degraded or unavailable; System Health and the watchdog report it.",
  page: "Shows the standard error state; nothing is written.",
  route: "Returns an error status; the caller retries and the run record shows the failure.",
  action: "Returns a typed error to the form; no partial write.",
  workflow:
    "The run fails on purpose so GitHub's failure email reaches the Owner; the run record shows it.",
  table: "A failed write rolls back; the data-quality and health checks flag gaps.",
  slot: "A missed slot is caught up by the Worker clock or reported by the watchdog.",
  "llm-role": "Falls back to rules-only output; no free text is ever required.",
  "llm-provider": "The router moves to the next provider in the roster or stays rules-only.",
  host: "The calling job retries, then records a failed fetch; no data is invented.",
  secret:
    "A missing or expired value fails the smoke test and the self-check; no value is ever shown.",
  source: "A disabled or pending source is not fetched; its status is shown on the Data page.",
  agent: "Skipped for the day with a reason in the run record.",
  group: "Marked stale in the Cortex state; shadow results are not promoted.",
};

const OWNER_OF_TYPE = {
  page: "app",
  route: "app",
  action: "app",
  workflow: "actions",
  table: "database",
  slot: "worker",
  host: "external",
  secret: "owner",
  source: "external",
  "llm-role": "app",
  "llm-provider": "external",
};

const SERVICE_OF_OWNER = {
  app: "service:app",
  worker: "service:worker",
  actions: "service:actions",
};

function el(id, type, name, extra = {}) {
  return {
    id,
    type,
    name,
    purpose: "",
    specIds: [],
    owner: OWNER_OF_TYPE[type] ?? "app",
    schedule: null,
    inputs: [],
    outputs: [],
    configKeys: [],
    tables: [],
    failure: "",
    runbook: null,
    views: [],
    source: null,
    attrs: {},
    ...extra,
  };
}

/** Everything the code says exists: elements and the edges the code itself proves. */
export function readCode(root, specMap = {}) {
  const elements = new Map();
  const edges = [];
  const add = (e) => elements.set(e.id, e);
  const edge = (from, kind, to, contract) => edges.push({ from, to, kind, contract });

  const { pages, routes, actions } = readRoutes(root);
  const fileOwners = new Map(); // source file -> element ids that live in it
  const own = (file, id) => fileOwners.set(file, [...(fileOwners.get(file) ?? []), id]);
  for (const p of pages) {
    const id = `page:${p.url}`;
    add(el(id, "page", p.url, { source: p.file }));
    own(p.file, id);
  }
  for (const r of routes) {
    const id = `route:${r.method}:${r.url}`;
    add(
      el(id, "route", `${r.method} ${r.url}`, {
        source: r.file,
        attrs: { method: r.method, path: r.url },
      }),
    );
    own(r.file, id);
  }
  for (const a of actions) {
    const id = `action:${a.file}#${a.name}`;
    add(el(id, "action", a.name, { source: a.file, attrs: { file: a.file } }));
    own(a.file, id);
  }

  const wfs = readWorkflows(root);
  const secrets = readSecrets(root);
  const secretNames = new Set(secrets.map((s) => s.name));
  for (const w of wfs) {
    const id = `workflow:${w.key}`;
    add(
      el(id, "workflow", w.name, {
        source: w.file,
        schedule: w.crons.length
          ? `cron (UTC): ${w.crons.join("; ")}`
          : w.triggers.includes("workflow_dispatch") && w.triggers.length === 1
            ? "dispatch only"
            : null,
        attrs: { file: w.file, triggers: w.triggers, jobs: w.jobs },
      }),
    );
    for (const s of w.secrets) {
      if (secretNames.has(s))
        edge(
          id,
          "uses",
          `secret:${s}`,
          `Reads the secret ${s} from the GitHub environment (name only).`,
        );
    }
  }

  for (const t of readTables(root)) {
    add(
      el(`table:${t.db}.${t.name}`, "table", t.name, {
        source: `db/migrations/${t.db}/${t.migration}`,
        attrs: { database: t.db, columns: t.columns, indexes: t.indexes },
      }),
    );
  }

  const { slots, dispatchable } = readSlots(root);
  for (const s of slots) {
    const id = `slot:${s.id}`;
    const when = s.until
      ? `${s.time}-${s.until}${s.everyMin ? ` every ${s.everyMin} min` : ""}`
      : s.time;
    add(
      el(id, "slot", s.id, {
        source: "worker/src/schedule.ts",
        owner: "worker",
        purpose: s.note,
        schedule: `${when} Australia/Sydney local`,
        attrs: {
          runner: s.runner,
          enabled: s.enabled,
          workflow: s.workflow,
          route: s.route,
          dispatchable: s.workflow ? dispatchable.includes(s.workflow) : false,
        },
      }),
    );
    if (s.workflow) {
      edge(
        id,
        "dispatch",
        `workflow:${s.workflow.replace(/\.ya?ml$/, "")}`,
        "workflow_dispatch from the Worker clock with the dispatch token (name only).",
      );
    }
    if (s.route)
      edge(id, "http", `route:POST:${s.route}`, "Signed POST (HMAC) from the Worker to the app.");
  }

  const { roles, roster } = readLlm(root);
  const providers = [...new Set(roster.map((r) => r.provider))].sort();
  for (const r of roles) {
    add(
      el(`llm-role:${r}`, "llm-role", r, {
        source: "src/lib/llm/budget.ts",
        attrs: {
          candidates: roster
            .filter((m) => m.roles.includes(r))
            .map((m) => `${m.provider}/${m.modelId}`)
            .sort(),
        },
      }),
    );
  }
  for (const p of providers) {
    const models = roster.filter((m) => m.provider === p);
    add(
      el(`llm-provider:${p}`, "llm-provider", p, {
        source: "src/lib/llm/roster.ts",
        attrs: { models: models.map((m) => m.modelId).sort() },
      }),
    );
    for (const r of roles) {
      if (models.some((m) => m.roles.includes(r)))
        edge(
          `llm-role:${r}`,
          "http",
          `llm-provider:${p}`,
          "Role candidate in the roster; called only after a bake-off passes.",
        );
    }
  }

  for (const s of readSources(root)) {
    add(
      el(`source:${s.id}`, "source", s.id, {
        source: "db/migrations/main",
        attrs: { permittedUse: s.permittedUse, risk: s.risk, status: s.status },
      }),
    );
  }

  const storeService = {
    "github-env": "service:actions",
    "vercel-env": "service:app",
    "cloudflare-worker": "service:worker",
  };
  for (const s of secrets) {
    const id = `secret:${s.name}`;
    add(
      el(id, "secret", s.name, {
        source: "src/lib/security/secretStores.ts",
        attrs: { stores: s.stores.map((x) => `${x.env}: ${x.store} (${x.holder})`) },
      }),
    );
    for (const store of new Set(s.stores.map((x) => x.store))) {
      if (storeService[store])
        edge(
          id,
          "stored-in",
          storeService[store],
          "Held in this store by name; the value is never read here.",
        );
    }
  }

  const hosts = readHosts(root, specMap.testOnlyHosts ?? []);
  for (const [host, files] of hosts) {
    const id = `host:${host}`;
    add(el(id, "host", host, { source: files[0], attrs: { files } }));
    const callers = new Set();
    for (const f of files) {
      const owners = fileOwners.get(f);
      if (owners?.length) owners.forEach((o) => callers.add(o));
      else callers.add(f.startsWith("worker/") ? "service:worker" : "service:app");
    }
    for (const c of [...callers].sort()) edge(c, "http", id, "HTTPS request to an external host.");
  }

  return { elements, edges };
}

function applyMap(elements, edges, specMap) {
  const problems = [];
  const rules = (specMap.rules ?? []).map((r) => ({ re: globRe(String(r.match)), r }));
  const explicit = specMap.elements ?? {};
  const FIELDS = [
    "name",
    "purpose",
    "specIds",
    "owner",
    "schedule",
    "inputs",
    "outputs",
    "configKeys",
    "tables",
    "failure",
    "runbook",
    "views",
    "x",
    "y",
  ];

  for (const [id, entry] of Object.entries(explicit)) {
    if (!elements.has(id)) {
      if (!entry?.type) {
        problems.push(
          `spec_map names ${id}, which is not in the code (add a type to define a hand-kept element)`,
        );
        continue;
      }
      elements.set(
        id,
        el(id, entry.type, entry.name ?? id.slice(id.indexOf(":") + 1), {
          owner: entry.owner ?? "app",
        }),
      );
    }
  }
  for (const e of elements.values()) {
    const apply = (src) => {
      for (const f of FIELDS) if (src[f] !== undefined) e[f] = src[f];
      if (src.attrs) e.attrs = { ...e.attrs, ...src.attrs };
    };
    for (const { re, r } of rules) if (re.test(e.id)) apply(r);
    if (explicit[e.id]) apply(explicit[e.id]);
    if (typeof e.purpose === "string") e.purpose = e.purpose.replaceAll("{name}", e.name);
    if (!e.purpose) e.purpose = "";
    if (!e.failure) e.failure = DEFAULT_FAILURE[e.type] ?? "";
  }
  for (const r of specMap.rules ?? []) {
    if (![...elements.keys()].some((id) => globRe(String(r.match)).test(id)) && !r.optional) {
      problems.push(`spec_map rule matches nothing: ${r.match}`);
    }
  }

  const out = new Map();
  const put = (g) => {
    out.set(`${g.from}|${g.kind}|${g.to}`, g);
  };
  for (const g of edges) put(g);
  // containment: the service that runs an element
  const dbService = { main: "service:turso-main", auth: "service:turso-auth" };
  for (const e of elements.values()) {
    const svc = e.type === "table" ? dbService[e.attrs.database] : SERVICE_OF_OWNER[e.owner];
    if (
      svc &&
      elements.has(svc) &&
      svc !== e.id &&
      ["page", "route", "action", "workflow", "slot", "table"].includes(e.type)
    ) {
      put({ from: svc, to: e.id, kind: "contains", contract: "Runs or holds this element." });
    }
  }
  for (const g of specMap.edges ?? [])
    put({
      from: g.from,
      to: g.to,
      kind: g.kind ?? "data",
      contract: g.contract ?? "",
      views: g.views,
      hand: true,
    });

  const finalEdges = [];
  for (const g of out.values()) {
    const a = elements.get(g.from);
    const b = elements.get(g.to);
    if (!a || !b) {
      if (g.hand)
        problems.push(`spec_map edge ${g.from} -> ${g.to} names an element that does not exist`);
      continue;
    }
    const common = a.views.filter((v) => b.views.includes(v));
    const views = g.views ? g.views : common;
    if (g.hand) {
      for (const v of views)
        if (!common.includes(v))
          problems.push(`spec_map edge ${g.from} -> ${g.to}: view ${v} is not shared by both ends`);
    }
    if (views.length === 0) continue;
    finalEdges.push({
      id: `${g.from}|${g.kind}|${g.to}`,
      from: g.from,
      to: g.to,
      kind: g.kind,
      contract: g.contract,
      views: [...views].sort(cmp),
    });
  }
  return { edges: finalEdges.sort((x, y) => cmp(x.id, y.id)), problems };
}

const orderEl = (e) => {
  const o = {
    id: e.id,
    type: e.type,
    name: e.name,
    purpose: e.purpose,
    specIds: [...new Set(e.specIds)].sort(cmp),
    owner: e.owner,
    schedule: e.schedule ?? null,
    inputs: e.inputs,
    outputs: e.outputs,
    configKeys: e.configKeys,
    tables: e.tables,
    failure: e.failure,
    runbook: e.runbook ?? null,
    views: [...new Set(e.views)].sort(cmp),
    source: e.source ?? null,
    attrs: Object.fromEntries(
      Object.entries(e.attrs)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(([a], [b]) => cmp(a, b)),
    ),
  };
  if (typeof e.x === "number") o.x = e.x;
  if (typeof e.y === "number") o.y = e.y;
  return o;
};

/** Returns { model, problems }. `problems` is empty when the model is valid and complete. */
export function buildModel(root = ROOT) {
  const mapFile = path.join(root, SPEC_MAP_PATH);
  const specMap = fs.existsSync(mapFile) ? (parseYaml(fs.readFileSync(mapFile, "utf8")) ?? {}) : {};
  const { elements, edges } = readCode(root, specMap);
  const { edges: finalEdges, problems } = applyMap(elements, edges, specMap);
  const model = {
    schemaVersion: SCHEMA_VERSION,
    views: VIEWS,
    elements: [...elements.values()].map(orderEl).sort((a, b) => cmp(a.id, b.id)),
    edges: finalEdges,
  };
  const all = [...problems, ...validateModel(model)];
  return { model, problems: all };
}

export const render = (model) => JSON.stringify(model, null, 2) + "\n";

export function main(argv = process.argv.slice(2), root = ROOT, out = console.log) {
  const check = argv.includes("--check");
  const { model, problems } = buildModel(root);
  if (problems.length) {
    for (const p of problems.slice(0, 50)) out(`architecture: ${p}`);
    if (problems.length > 50) out(`architecture: ... and ${problems.length - 50} more`);
    return 1;
  }
  const text = render(model);
  const file = path.join(root, MODEL_PATH);
  if (check) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (cur === text) {
      out("architecture: up to date");
      return 0;
    }
    out(`architecture: ${MODEL_PATH} is stale. Run: node scripts/architecture/generate.mjs`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  out(
    `architecture: wrote ${MODEL_PATH} (${model.elements.length} elements, ${model.edges.length} edges)`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
