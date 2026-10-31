// The architecture model schema (ARC-001, UXN-297/298, M16 WP2) as a typed validator, zero deps.
// The model holds NAMES and STRUCTURE only: never a secret value, fingerprint, hint, email or
// token (SEC-113, SEC-017). `findSecretShapes` is the guard the generator and its tests both use.

export const SCHEMA_VERSION = 1;

/** Element types. page / route / action are the "routes" kind of AT-58. */
export const ELEMENT_TYPES = [
  "service",
  "page",
  "route",
  "action",
  "workflow",
  "table",
  "slot",
  "llm-role",
  "llm-provider",
  "host",
  "secret",
  "source",
  "agent",
  "group",
];

/** The eight tabs of the page (UXN-297). */
export const VIEWS = [
  { id: "platform", name: "Platform" },
  { id: "data", name: "Data" },
  { id: "cortex", name: "Cortex pipeline" },
  { id: "agents", name: "Agents and schedule" },
  { id: "llm", name: "LLM router" },
  { id: "email", name: "Email and alerts" },
  { id: "security", name: "Security and roles" },
  { id: "learning", name: "Learning loop" },
];
export const VIEW_IDS = VIEWS.map((v) => v.id);

export const OWNERS = ["app", "worker", "actions", "external", "database", "owner"];
export const EDGE_KINDS = ["data", "dispatch", "http", "email", "contains", "uses", "stored-in"];

/** Element id: "<type>:<key>"; the key may hold path characters, dots, brackets and "#". */
export const ID_RE = new RegExp(`^(${ELEMENT_TYPES.join("|")}):[A-Za-z0-9_./\\[\\]()@#:+*-]+$`);
/** A spec requirement id: PLT-073, DAT-125a, UXN-297, AT-58, ARC-001. */
export const SPEC_ID_RE = /^[A-Z]{2,5}-\d{2,3}[a-z]?$/;

const ELEMENT_KEYS = [
  "id",
  "type",
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
  "source",
  "attrs",
  "x",
  "y",
];
const EDGE_KEYS = ["id", "from", "to", "kind", "contract", "views"];
export { ELEMENT_KEYS, EDGE_KEYS };

const isStr = (v) => typeof v === "string";
const strList = (v) => Array.isArray(v) && v.every(isStr);

/** Secret-shaped strings: key prefixes, tokens, JWTs, long opaque runs, emails, connection URLs. */
export const SECRET_SHAPES = [
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/],
  [
    "api key (sk-/gsk_/re_/AIza)",
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|re_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})/,
  ],
  ["aws key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["long hex run", /\b[0-9a-fA-F]{32,}\b/],
  [
    "long opaque run",
    /(?<![A-Za-z0-9_/.-])(?=[A-Za-z0-9+]*\d)(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[A-Z])[A-Za-z0-9+]{40,}/,
  ],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ["connection url with credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i],
  ["database url", /\b(?:libsql|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
];

/** Returns [{ rule, sample }] for every secret-shaped substring of `text` (sample is truncated). */
export function findSecretShapes(text) {
  const out = [];
  for (const [rule, re] of SECRET_SHAPES) {
    const m = re.exec(text);
    if (m) out.push({ rule, sample: m[0].slice(0, 6) + "..." });
  }
  return out;
}

/** Problems with a model object; [] when valid. Never throws. */
export function validateModel(model) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!model || typeof model !== "object") return ["model is not an object"];
  if (model.schemaVersion !== SCHEMA_VERSION) bad(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (JSON.stringify(model.views) !== JSON.stringify(VIEWS))
    bad("views must be the eight fixed views");
  if (!Array.isArray(model.elements)) return [...problems, "elements must be an array"];
  if (!Array.isArray(model.edges)) return [...problems, "edges must be an array"];
  const ids = new Set();
  for (const e of model.elements) {
    const at = `element ${e?.id}`;
    if (!e || typeof e !== "object") {
      bad("element is not an object");
      continue;
    }
    for (const k of Object.keys(e)) if (!ELEMENT_KEYS.includes(k)) bad(`${at}: unknown field ${k}`);
    if (!isStr(e.id) || !ID_RE.test(e.id)) bad(`${at}: id does not match the id pattern`);
    if (ids.has(e.id)) bad(`${at}: duplicate id`);
    ids.add(e.id);
    if (!ELEMENT_TYPES.includes(e.type)) bad(`${at}: unknown type ${e.type}`);
    else if (isStr(e.id) && !e.id.startsWith(`${e.type}:`))
      bad(`${at}: id prefix differs from type`);
    if (!isStr(e.name) || e.name === "") bad(`${at}: name is required`);
    if (!isStr(e.purpose) || e.purpose === "") bad(`${at}: purpose is required`);
    if (!strList(e.specIds) || e.specIds.length < 1) bad(`${at}: needs at least one spec ID`);
    else for (const s of e.specIds) if (!SPEC_ID_RE.test(s)) bad(`${at}: bad spec ID ${s}`);
    if (!OWNERS.includes(e.owner)) bad(`${at}: owner must be one of ${OWNERS.join(", ")}`);
    if (e.schedule !== null && !isStr(e.schedule)) bad(`${at}: schedule must be text or null`);
    for (const k of ["inputs", "outputs", "configKeys", "tables"]) {
      if (!strList(e[k])) bad(`${at}: ${k} must be a list of text`);
    }
    if (!isStr(e.failure)) bad(`${at}: failure must be text`);
    if (e.runbook !== null && !isStr(e.runbook)) bad(`${at}: runbook must be text or null`);
    if (!strList(e.views) || e.views.length < 1) bad(`${at}: needs at least one view`);
    else for (const v of e.views) if (!VIEW_IDS.includes(v)) bad(`${at}: unknown view ${v}`);
    if (e.source !== null && !isStr(e.source)) bad(`${at}: source must be a path or null`);
    if (!e.attrs || typeof e.attrs !== "object" || Array.isArray(e.attrs))
      bad(`${at}: attrs must be an object`);
    for (const k of ["x", "y"])
      if (k in e && typeof e[k] !== "number") bad(`${at}: ${k} must be a number`);
  }
  const edgeIds = new Set();
  for (const g of model.edges) {
    const at = `edge ${g?.id}`;
    for (const k of Object.keys(g ?? {}))
      if (!EDGE_KEYS.includes(k)) bad(`${at}: unknown field ${k}`);
    if (g.id !== `${g.from}|${g.kind}|${g.to}`) bad(`${at}: id must be from|kind|to`);
    if (edgeIds.has(g.id)) bad(`${at}: duplicate id`);
    edgeIds.add(g.id);
    if (!ids.has(g.from)) bad(`${at}: from names no element`);
    if (!ids.has(g.to)) bad(`${at}: to names no element`);
    if (!EDGE_KINDS.includes(g.kind)) bad(`${at}: unknown kind ${g.kind}`);
    if (!isStr(g.contract)) bad(`${at}: contract must be text`);
    if (!strList(g.views) || g.views.length < 1) bad(`${at}: needs at least one view`);
    else for (const v of g.views) if (!VIEW_IDS.includes(v)) bad(`${at}: unknown view ${v}`);
  }
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  for (const g of model.edges) {
    const a = byId.get(g.from);
    const b = byId.get(g.to);
    if (!a || !b || !Array.isArray(g.views)) continue;
    for (const v of g.views) {
      if (!a.views?.includes(v) || !b.views?.includes(v))
        bad(`edge ${g.id}: view ${v} is not shared by both ends`);
    }
  }
  for (const f of findSecretShapes(JSON.stringify(model))) {
    bad(`secret-shaped value in the model: ${f.rule} (${f.sample})`);
  }
  return problems;
}
