// Validator for the expert seed format `praxis-expert-seed/1` (M13-lite WP3; D-513, D-514, D-521, D-531).
// Plain JS so the Owner-run importer and vitest share it. Pure: no I/O, no database, no network.
// An error names the file and the path and the rule, NEVER the offending value (the data is private).
// Unknown keys are rejected at every level, so no field that could carry an article, a transcript or a page
// can arrive (PRD-036). The semantic family-fit check (parameter keys and bounds of F1..F6) is the app's
// `src/lib/experts/fit.ts` at run time (D-514); here only the SHAPE of `family_fit` is checked.

export const FORMAT = "praxis-expert-seed/1";
/** Format 2 (M22 E4, KB-085) adds three optional files: licence-check.json, call-proposals.json, expressions.json. */
export const FORMAT_V2 = "praxis-expert-seed/2";
export const FORMATS = [FORMAT, FORMAT_V2];
export const LICENCE_FORMAT = "praxis-licence-check/1";
export const PROPOSALS_FORMAT = "praxis-call-proposals/1";

/** Length caps (characters), equal to the CHECKs of db/migrations/main/0022_experts.sql. */
export const CAPS = {
  id: 32,
  name: 120,
  handle: 200,
  url: 500,
  platform: 40,
  tag: 60,
  title: 200,
  summary: 800,
  quote: 160,
  redFlag: 400,
  statement: 600,
  formalisation: 1200,
  gap: 300,
  edge: 400,
  clusterName: 120,
  evidenceNote: 120,
  market: 16,
  code: 32,
};
export const SUMMARY_WORDS = 80;
export const QUOTE_WORDS = 15;

export const EXPERT_STATUS = ["candidate", "tracked", "paused", "retired"];
export const TIERS = ["core", "discovered"];
export const LICENCE = ["unchecked", "registered", "not_registered", "not_applicable"];
export const ITEM_KINDS = ["method", "call", "market_view", "other"];
export const ITEM_EXTRACTION = ["seeded", "pending", "extracted", "failed"];
export const CLAIM_TYPES = ["method", "event_link", "call", "risk_rule"];
export const TESTABILITY = ["testable_eod", "needs_new_data", "needs_intraday", "not_testable"];
export const CATEGORIES = [
  "candlesticks",
  "chart_patterns",
  "trend_momentum",
  "mean_reversion",
  "volume",
  "events_news",
  "macro",
  "risk_rules",
  "fundamentals_value",
  "calendar",
  "none",
];
export const EXTERNAL_GRADES = ["supports", "mixed", "contradicts", "none", "not_searched"];
export const CLOSEST_FAMILY = ["F1", "F2", "F3", "F4", "F5", "F6", "new", "overlay"];
export const FIT_FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"];
export const DIRECTIONS = ["long", "short"];

/** JSON-column caps of 0022 `expert` (the importer stores these arrays as JSON text). */
export const JSON_CAPS = {
  platforms: 500,
  home_urls: 1500,
  markets: 200,
  focus: 500,
  handles: 1000,
};

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** A platform id or an enum word: short, lower-case, no whitespace (never free text). */
const isWord = (v) => typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isInt = (v) => Number.isInteger(v);
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isUrl = (v) => typeof v === "string" && /^https?:\/\/[^\s]{1,}$/i.test(v) && v.length >= 8;

/** Whitespace-separated word count (our own text only; no page text is ever counted). */
export function wordCount(text) {
  const t = String(text).trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/** Number of quoted spans in a string (straight or curly double quotes). */
function quotedSpans(text) {
  const straight = (text.match(/"[^"]+"/g) ?? []).length;
  const curly = (text.match(/“[^”]+”/g) ?? []).length;
  return straight + curly;
}

/** A collector of errors: file + path + rule, never the offending value. */
function collector() {
  const list = [];
  const at = (file, p, msg) => list.push(`${file}: ${p}: ${msg}`);
  const check = (file, p, cond, msg) => {
    if (!cond) at(file, p, msg);
    return cond;
  };
  return { list, at, check };
}

/** Rejects every key of `o` that is not in `allowed` (naming the key is safe: keys are format, not data). */
function noUnknownKeys(e, file, p, o, allowed) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) e.at(file, `${p}.${k}`, "unknown key");
  }
}

function strCap(e, file, p, v, cap, { optional = false } = {}) {
  if (optional && (v === null || v === undefined)) return true;
  if (
    !e.check(file, p, isStr(v), optional ? "string or null required" : "non-empty string required")
  )
    return false;
  return e.check(file, p, v.length <= cap, `longer than ${cap} characters`);
}

function strArr(e, file, p, v, cap, maxItems) {
  if (!e.check(file, p, Array.isArray(v), "array required")) return;
  e.check(file, p, v.length <= maxItems, `more than ${maxItems} entries`);
  v.forEach((x, i) => strCap(e, file, `${p}[${i}]`, x, cap));
}

export function validateManifest(m) {
  const e = collector();
  const f = "manifest.json";
  if (e.check(f, "$", isObj(m), "object required")) {
    noUnknownKeys(e, f, "$", m, ["format", "market", "created_at"]);
    e.check(f, "format", FORMATS.includes(m.format), `must be ${FORMATS.join(" or ")}`);
    strCap(e, f, "market", m.market, CAPS.market);
    e.check(
      f,
      "created_at",
      isStr(m.created_at) && m.created_at.length <= 40 && !Number.isNaN(Date.parse(m.created_at)),
      "ISO date-time required",
    );
  }
  return e.list;
}

const EXPERT_KEYS = [
  "id",
  "name",
  "platforms",
  "handles",
  "home_urls",
  "markets",
  "focus",
  "status",
  "tier",
  "no_feed",
  "licence_status",
  "audience_size",
  "audience_d",
  "red_flags",
];

export function validateExperts(j) {
  const e = collector();
  const f = "experts.json";
  if (!e.check(f, "$", isObj(j) && Array.isArray(j.experts), "{ experts: [] } required"))
    return e.list;
  noUnknownKeys(e, f, "$", j, ["experts"]);
  const seen = new Set();
  j.experts.forEach((x, i) => {
    const p = `experts[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, EXPERT_KEYS);
    if (strCap(e, f, `${p}.id`, x.id, CAPS.id)) {
      e.check(f, `${p}.id`, !seen.has(x.id), "duplicate id");
      seen.add(x.id);
    }
    strCap(e, f, `${p}.name`, x.name, CAPS.name);
    strArr(e, f, `${p}.platforms`, x.platforms, CAPS.platform, 12);
    if (e.check(f, `${p}.handles`, isObj(x.handles), "object required")) {
      Object.entries(x.handles).forEach(([k, v], n) => {
        // The key is a platform id; an arbitrary key would be printed in the path, so it is checked by
        // position and never echoed.
        if (e.check(f, `${p}.handles[${n}]`, isWord(k), "key must be a platform id"))
          strCap(e, f, `${p}.handles.${k}`, v, CAPS.handle);
      });
    }
    if (e.check(f, `${p}.home_urls`, Array.isArray(x.home_urls), "array required")) {
      e.check(f, `${p}.home_urls`, x.home_urls.length <= 5, "more than 5 entries");
      x.home_urls.forEach((u, k) =>
        e.check(
          f,
          `${p}.home_urls[${k}]`,
          isUrl(u) && u.length <= CAPS.url,
          "http(s) URL (max 500) required",
        ),
      );
    }
    strArr(e, f, `${p}.markets`, x.markets, CAPS.market, 8);
    strArr(e, f, `${p}.focus`, x.focus, CAPS.tag, 8);
    // The 0022 JSON-column caps, so an over-long array is named here and not refused by the database.
    for (const [k, cap] of Object.entries(JSON_CAPS)) {
      if (x[k] !== undefined && x[k] !== null)
        e.check(
          f,
          `${p}.${k}`,
          JSON.stringify(x[k]).length <= cap,
          `longer than ${cap} characters as JSON`,
        );
    }
    e.check(f, `${p}.status`, EXPERT_STATUS.includes(x.status), "unknown status");
    e.check(f, `${p}.tier`, TIERS.includes(x.tier), "unknown tier");
    e.check(f, `${p}.no_feed`, typeof x.no_feed === "boolean", "boolean required");
    e.check(
      f,
      `${p}.licence_status`,
      x.licence_status === undefined || LICENCE.includes(x.licence_status),
      "unknown licence_status",
    );
    e.check(
      f,
      `${p}.audience_size`,
      x.audience_size === undefined ||
        x.audience_size === null ||
        (isInt(x.audience_size) && x.audience_size >= 0),
      "integer >= 0 or null required",
    );
    e.check(
      f,
      `${p}.audience_d`,
      x.audience_d === undefined || x.audience_d === null || isDay(x.audience_d),
      "YYYY-MM-DD or null required",
    );
    e.check(
      f,
      p,
      (x.audience_size === undefined || x.audience_size === null) ===
        (x.audience_d === undefined || x.audience_d === null),
      "audience_size and audience_d go together",
    );
    const flags = x.red_flags === undefined ? [] : x.red_flags;
    if (e.check(f, `${p}.red_flags`, Array.isArray(flags), "array required")) {
      e.check(f, `${p}.red_flags`, flags.length <= 10, "more than 10 entries");
      flags.forEach((r, k) => {
        const q = `${p}.red_flags[${k}]`;
        if (!e.check(f, q, isObj(r), "object required")) return;
        noUnknownKeys(e, f, q, r, ["text", "source_url", "noted_d"]);
        strCap(e, f, `${q}.text`, r.text, CAPS.redFlag);
        // D-521: no unsourced flag.
        e.check(
          f,
          `${q}.source_url`,
          isUrl(r.source_url) && r.source_url.length <= CAPS.url,
          "source_url (http(s), max 500) required",
        );
        e.check(f, `${q}.noted_d`, isDay(r.noted_d), "YYYY-MM-DD required");
      });
    }
  });
  return e.list;
}

const ITEM_KEYS = [
  "expert_id",
  "url",
  "platform",
  "title",
  "published_at",
  "content_hash",
  "summary",
  "quote",
  "kind",
  "extraction_status",
];

export function validateItems(j) {
  const e = collector();
  const f = "items.json";
  if (!e.check(f, "$", isObj(j) && Array.isArray(j.items), "{ items: [] } required")) return e.list;
  noUnknownKeys(e, f, "$", j, ["items"]);
  const seen = new Set();
  j.items.forEach((x, i) => {
    const p = `items[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    // D-513: metadata only. An unknown key (body, text, content, ...) is rejected here.
    noUnknownKeys(e, f, p, x, ITEM_KEYS);
    strCap(e, f, `${p}.expert_id`, x.expert_id, CAPS.id);
    if (
      e.check(
        f,
        `${p}.url`,
        isUrl(x.url) && x.url.length <= CAPS.url,
        "http(s) URL (max 500) required",
      )
    ) {
      const hash = x.content_hash ?? null;
      const key = `${x.url}|${hash ?? ""}`;
      e.check(f, p, !seen.has(key), "duplicate (url, content_hash)");
      seen.add(key);
    }
    strCap(e, f, `${p}.platform`, x.platform, CAPS.platform);
    strCap(e, f, `${p}.title`, x.title, CAPS.title, { optional: true });
    strCap(e, f, `${p}.published_at`, x.published_at, 40, { optional: true });
    e.check(
      f,
      `${p}.content_hash`,
      x.content_hash === undefined ||
        x.content_hash === null ||
        /^[0-9a-f]{64}$/.test(String(x.content_hash)),
      "64 lower-case hex or null required",
    );
    if (
      strCap(e, f, `${p}.summary`, x.summary, CAPS.summary, { optional: true }) &&
      isStr(x.summary)
    ) {
      e.check(
        f,
        `${p}.summary`,
        wordCount(x.summary) <= SUMMARY_WORDS,
        `more than ${SUMMARY_WORDS} words`,
      );
    }
    if (x.quote !== undefined && x.quote !== null) {
      // PRD-036: at most one quote, at most 15 words.
      if (
        e.check(
          f,
          `${p}.quote`,
          typeof x.quote === "string",
          "a single string required (at most one quote)",
        )
      ) {
        strCap(e, f, `${p}.quote`, x.quote, CAPS.quote);
        e.check(
          f,
          `${p}.quote`,
          wordCount(x.quote) <= QUOTE_WORDS,
          `more than ${QUOTE_WORDS} words`,
        );
        e.check(f, `${p}.quote`, quotedSpans(x.quote) <= 1, "more than one quote");
      }
    }
    e.check(f, `${p}.kind`, ITEM_KINDS.includes(x.kind), "unknown kind");
    e.check(
      f,
      `${p}.extraction_status`,
      ITEM_EXTRACTION.includes(x.extraction_status),
      "unknown extraction_status",
    );
  });
  return e.list;
}

const CLAIM_KEYS = [
  "id",
  "type",
  "testability",
  "statement",
  "formalisation",
  "vocabulary_gap",
  "claimed_edge",
  "experts",
  "items",
  "cluster_id",
];

export function validateClaims(j) {
  const e = collector();
  const f = "claims.json";
  if (!e.check(f, "$", isObj(j) && Array.isArray(j.claims), "{ claims: [] } required"))
    return e.list;
  noUnknownKeys(e, f, "$", j, ["claims"]);
  const seen = new Set();
  j.claims.forEach((x, i) => {
    const p = `claims[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, CLAIM_KEYS);
    if (strCap(e, f, `${p}.id`, x.id, CAPS.id)) {
      e.check(f, `${p}.id`, !seen.has(x.id), "duplicate id");
      seen.add(x.id);
    }
    e.check(f, `${p}.type`, CLAIM_TYPES.includes(x.type), "unknown type");
    e.check(f, `${p}.testability`, TESTABILITY.includes(x.testability), "unknown testability");
    strCap(e, f, `${p}.statement`, x.statement, CAPS.statement);
    strCap(e, f, `${p}.formalisation`, x.formalisation, CAPS.formalisation, { optional: true });
    strCap(e, f, `${p}.vocabulary_gap`, x.vocabulary_gap, CAPS.gap, { optional: true });
    strCap(e, f, `${p}.claimed_edge`, x.claimed_edge, CAPS.edge, { optional: true });
    if (
      e.check(
        f,
        `${p}.experts`,
        Array.isArray(x.experts) && x.experts.length >= 1,
        "at least one expert required",
      )
    ) {
      x.experts.forEach((k, n) => strCap(e, f, `${p}.experts[${n}]`, k, CAPS.id));
    }
    const items = x.items === undefined ? [] : x.items;
    if (e.check(f, `${p}.items`, Array.isArray(items), "array of item URLs required")) {
      items.forEach((u, n) =>
        e.check(
          f,
          `${p}.items[${n}]`,
          isUrl(u) && u.length <= CAPS.url,
          "http(s) URL (max 500) required",
        ),
      );
    }
    if (x.cluster_id !== undefined && x.cluster_id !== null)
      strCap(e, f, `${p}.cluster_id`, x.cluster_id, CAPS.id);
  });
  return e.list;
}

const CLUSTER_KEYS = [
  "id",
  "name",
  "category",
  "statement",
  "canonical_text",
  "testability",
  "external_grade",
  "evidence_links",
  "vocabulary_gaps",
  "closest_family",
  "family_fit",
  "supports",
  "contradicts",
];

/** D-514: the SHAPE of a family fit only; keys and bounds are checked by src/lib/experts/fit.ts at run time. */
function validateFitShape(e, file, p, fit) {
  if (fit === null || fit === undefined) return;
  if (!e.check(file, p, isObj(fit), "object or null required")) return;
  noUnknownKeys(e, file, p, fit, ["family", "params"]);
  e.check(file, `${p}.family`, FIT_FAMILIES.includes(fit.family), "F1..F6 required");
  if (e.check(file, `${p}.params`, isObj(fit.params), "object required")) {
    e.check(
      file,
      `${p}.params`,
      Object.keys(fit.params).length >= 1,
      "at least one parameter required",
    );
    Object.entries(fit.params).forEach(([k, v], n) => {
      if (!e.check(file, `${p}.params[${n}]`, isWord(k), "key must be a parameter key")) return;
      // A number (ranged Lane-B key), a boolean, or an enum word for a structural key such as
      // `f1_momentum_variant` (FAMILY_OPTIONAL_KEYS); never free text, never an object.
      e.check(
        file,
        `${p}.params.${k}`,
        (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || isWord(v),
        "finite number, boolean or enum word required",
      );
    });
    e.check(
      file,
      `${p}.params`,
      JSON.stringify(fit.params).length <= 1500,
      "longer than 1500 characters",
    );
  }
}

export function validateClusters(j) {
  const e = collector();
  const f = "clusters.json";
  if (!e.check(f, "$", isObj(j) && Array.isArray(j.clusters), "{ clusters: [] } required"))
    return e.list;
  noUnknownKeys(e, f, "$", j, ["clusters"]);
  const seen = new Set();
  j.clusters.forEach((x, i) => {
    const p = `clusters[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, CLUSTER_KEYS);
    if (strCap(e, f, `${p}.id`, x.id, CAPS.id)) {
      e.check(f, `${p}.id`, !seen.has(x.id), "duplicate id");
      seen.add(x.id);
    }
    strCap(e, f, `${p}.name`, x.name, CAPS.clusterName);
    e.check(f, `${p}.category`, CATEGORIES.includes(x.category), "unknown category");
    strCap(e, f, `${p}.statement`, x.statement, CAPS.statement);
    strCap(e, f, `${p}.canonical_text`, x.canonical_text, CAPS.formalisation, { optional: true });
    e.check(f, `${p}.testability`, TESTABILITY.includes(x.testability), "unknown testability");
    e.check(
      f,
      `${p}.external_grade`,
      EXTERNAL_GRADES.includes(x.external_grade),
      "unknown external_grade",
    );
    const links = x.evidence_links === undefined ? [] : x.evidence_links;
    if (e.check(f, `${p}.evidence_links`, Array.isArray(links), "array required")) {
      e.check(f, `${p}.evidence_links`, links.length <= 12, "more than 12 entries");
      links.forEach((l, k) => {
        const q = `${p}.evidence_links[${k}]`;
        if (!e.check(f, q, isObj(l), "object required")) return;
        noUnknownKeys(e, f, q, l, ["url", "note"]);
        e.check(
          f,
          `${q}.url`,
          isUrl(l.url) && l.url.length <= CAPS.url,
          "http(s) URL (max 500) required",
        );
        strCap(e, f, `${q}.note`, l.note, CAPS.evidenceNote);
      });
      e.check(
        f,
        `${p}.evidence_links`,
        JSON.stringify(links).length <= 4000,
        "longer than 4000 characters",
      );
    }
    e.check(
      f,
      `${p}.vocabulary_gaps`,
      x.vocabulary_gaps === undefined || (isInt(x.vocabulary_gaps) && x.vocabulary_gaps >= 0),
      "integer >= 0 required",
    );
    e.check(
      f,
      `${p}.closest_family`,
      x.closest_family === undefined ||
        x.closest_family === null ||
        CLOSEST_FAMILY.includes(x.closest_family),
      "unknown closest_family",
    );
    validateFitShape(e, f, `${p}.family_fit`, x.family_fit);
    for (const role of ["supports", "contradicts"]) {
      const v = x[role] === undefined ? [] : x[role];
      if (e.check(f, `${p}.${role}`, Array.isArray(v), "array of claim ids required")) {
        v.forEach((c, n) => strCap(e, f, `${p}.${role}[${n}]`, c, CAPS.id));
      }
    }
  });
  return e.list;
}

const CALL_KEYS = [
  "claim_id",
  "market",
  "code",
  "direction",
  "call_d",
  "horizon_sessions",
  "target_micro",
  "stop_micro",
  "tracked",
];

export function validateCalls(j) {
  const e = collector();
  const f = "calls.json";
  if (!e.check(f, "$", isObj(j) && Array.isArray(j.calls), "{ calls: [] } required")) return e.list;
  noUnknownKeys(e, f, "$", j, ["calls"]);
  const seen = new Set();
  j.calls.forEach((x, i) => {
    const p = `calls[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, CALL_KEYS);
    if (strCap(e, f, `${p}.claim_id`, x.claim_id, CAPS.id)) {
      e.check(f, `${p}.claim_id`, !seen.has(x.claim_id), "duplicate claim_id");
      seen.add(x.claim_id);
    }
    strCap(e, f, `${p}.market`, x.market, CAPS.market);
    strCap(e, f, `${p}.code`, x.code, CAPS.code);
    e.check(f, `${p}.direction`, DIRECTIONS.includes(x.direction), "long or short required");
    e.check(f, `${p}.call_d`, isDay(x.call_d), "YYYY-MM-DD required");
    e.check(
      f,
      `${p}.horizon_sessions`,
      isInt(x.horizon_sessions) && x.horizon_sessions >= 1,
      "integer >= 1 required",
    );
    for (const k of ["target_micro", "stop_micro"]) {
      e.check(
        f,
        `${p}.${k}`,
        x[k] === undefined || x[k] === null || (isInt(x[k]) && x[k] > 0),
        "integer > 0 or null required",
      );
    }
    e.check(f, `${p}.tracked`, typeof x.tracked === "boolean", "boolean required");
  });
  return e.list;
}

// ---- format 2 files (M22 E4) -----------------------------------------------------------------------------

export const LICENCE_ROBOTS = ["allows", "disallows", "absent", "unreachable"];
export const LICENCE_SUMMARISATION = ["yes", "no", "unknown"];
/** The importer never writes `owner-accepted-risk`: only the Owner's own action does (D-1471). */
export const LICENCE_IMPORT_STATUS = ["unchecked", "enabled", "no"];
export const PARK_REASONS = [
  "blocked_data",
  "needs_intraday",
  "discretionary",
  "overlay_only",
  "duplicate",
  "not_testable",
];
export const EXPRESSION_CAPS = { reason: 200, rule: 4000, exit: 2000, prereg: 4000 };
const isIsoTime = (v) =>
  isStr(v) && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

const LICENCE_KEYS = [
  "expert_id",
  "source_key",
  "checked_at",
  "terms_url",
  "robots",
  "summarisation",
  "status",
  "note",
];

/** licence-check.json written by scripts/experts/licence-check.mjs (E1). */
export function validateLicenceCheck(j) {
  const e = collector();
  const f = "licence-check.json";
  if (
    !e.check(
      f,
      "$",
      isObj(j) && Array.isArray(j.results),
      "{ format, checked_at, results: [] } required",
    )
  )
    return e.list;
  noUnknownKeys(e, f, "$", j, ["format", "checked_at", "results"]);
  e.check(f, "format", j.format === LICENCE_FORMAT, `must be ${LICENCE_FORMAT}`);
  e.check(f, "checked_at", isIsoTime(j.checked_at), "ISO date-time required");
  e.check(f, "results", j.results.length <= 5000, "more than 5000 entries");
  const seen = new Set();
  j.results.forEach((x, i) => {
    const p = `results[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, LICENCE_KEYS);
    strCap(e, f, `${p}.expert_id`, x.expert_id, CAPS.id);
    strCap(e, f, `${p}.source_key`, x.source_key, 64);
    e.check(f, `${p}.checked_at`, isIsoTime(x.checked_at), "ISO date-time required");
    e.check(
      f,
      `${p}.terms_url`,
      x.terms_url === null ||
        x.terms_url === undefined ||
        (isUrl(x.terms_url) && x.terms_url.length <= 500),
      "http(s) URL up to 500 characters or null required",
    );
    e.check(f, `${p}.robots`, LICENCE_ROBOTS.includes(x.robots), "unknown robots word");
    e.check(
      f,
      `${p}.summarisation`,
      LICENCE_SUMMARISATION.includes(x.summarisation),
      "unknown summarisation word",
    );
    e.check(
      f,
      `${p}.status`,
      LICENCE_IMPORT_STATUS.includes(x.status),
      "status must be unchecked, enabled or no",
    );
    strCap(e, f, `${p}.note`, x.note, 200, { optional: true });
    const key = `${x.expert_id}\u0000${x.source_key}\u0000${x.checked_at}`;
    e.check(f, p, !seen.has(key), "duplicate expert, source and time");
    seen.add(key);
  });
  return e.list;
}

const PROPOSAL_KEYS = [
  "claim_id",
  "state",
  "code",
  "direction",
  "call_d",
  "horizon_sessions",
  "price_basis",
  "target_micro",
  "stop_micro",
  "missing",
  "reason",
];

/** call-proposals.json written by scripts/experts/call-proposals.mjs (E3); shape only, nothing of it is stored. */
export function validateCallProposals(j) {
  const e = collector();
  const f = "call-proposals.json";
  if (
    !e.check(f, "$", isObj(j) && Array.isArray(j.proposals), "{ format, proposals: [] } required")
  )
    return e.list;
  noUnknownKeys(e, f, "$", j, ["format", "market", "created_at", "proposals"]);
  e.check(f, "format", j.format === PROPOSALS_FORMAT, `must be ${PROPOSALS_FORMAT}`);
  const seen = new Set();
  j.proposals.forEach((x, i) => {
    const p = `proposals[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, PROPOSAL_KEYS);
    if (strCap(e, f, `${p}.claim_id`, x.claim_id, CAPS.id)) {
      e.check(f, `${p}.claim_id`, !seen.has(x.claim_id), "duplicate claim_id");
      seen.add(x.claim_id);
    }
    e.check(
      f,
      `${p}.state`,
      ["complete", "incomplete", "not_trackable"].includes(x.state),
      "unknown state",
    );
    e.check(
      f,
      `${p}.price_basis`,
      ["open", "close", "unspecified"].includes(x.price_basis),
      "unknown price basis",
    );
    // a complete proposal has an empty reason
    e.check(
      f,
      `${p}.reason`,
      typeof x.reason === "string" && x.reason.length <= 200,
      "string up to 200 characters required",
    );
  });
  return e.list;
}

const EXPRESSION_KEYS = [
  "cluster_id",
  "version",
  "outcome",
  "rule",
  "exit",
  "preregistration",
  "park_reason",
  "reason",
];

/** expressions.json (D-1437): one entry per parked cluster: expressed with rule, exit and pre-registration, or parked with a reason. */
export function validateExpressions(j) {
  const e = collector();
  const f = "expressions.json";
  if (!e.check(f, "$", isObj(j) && Array.isArray(j.expressions), "{ expressions: [] } required"))
    return e.list;
  noUnknownKeys(e, f, "$", j, ["expressions"]);
  e.check(f, "expressions", j.expressions.length <= 200, "more than 200 entries");
  const seen = new Set();
  j.expressions.forEach((x, i) => {
    const p = `expressions[${i}]`;
    if (!e.check(f, p, isObj(x), "object required")) return;
    noUnknownKeys(e, f, p, x, EXPRESSION_KEYS);
    const ok = strCap(e, f, `${p}.cluster_id`, x.cluster_id, CAPS.id);
    const version = x.version === undefined ? 1 : x.version;
    e.check(f, `${p}.version`, isInt(version) && version >= 1, "integer >= 1 required");
    if (ok) {
      const key = `${x.cluster_id}\u0000${version}`;
      e.check(f, p, !seen.has(key), "duplicate cluster_id and version");
      seen.add(key);
    }
    strCap(e, f, `${p}.reason`, x.reason, EXPRESSION_CAPS.reason);
    if (x.outcome === "expressed") {
      e.check(
        f,
        `${p}.park_reason`,
        x.park_reason === undefined,
        "an expressed cluster has no park_reason",
      );
      if (e.check(f, `${p}.rule`, isObj(x.rule), "object required"))
        e.check(
          f,
          `${p}.rule`,
          JSON.stringify(x.rule).length <= EXPRESSION_CAPS.rule,
          `longer than ${EXPRESSION_CAPS.rule} characters as JSON`,
        );
      if (e.check(f, `${p}.exit`, isObj(x.exit), "object required"))
        e.check(
          f,
          `${p}.exit`,
          JSON.stringify(x.exit).length <= EXPRESSION_CAPS.exit,
          `longer than ${EXPRESSION_CAPS.exit} characters as JSON`,
        );
      strCap(e, f, `${p}.preregistration`, x.preregistration, EXPRESSION_CAPS.prereg);
    } else if (x.outcome === "parked") {
      for (const k of ["rule", "exit", "preregistration"])
        e.check(
          f,
          `${p}.${k}`,
          x[k] === undefined,
          "a parked cluster has no rule, exit or preregistration",
        );
      e.check(f, `${p}.park_reason`, PARK_REASONS.includes(x.park_reason), "unknown park reason");
    } else e.at(f, `${p}.outcome`, "expressed or parked required");
  });
  return e.list;
}

/**
 * Validates a whole seed: every file, then the references between them. `files` maps a file name to its
 * parsed JSON; `calls.json` is optional. Returns the list of errors (empty = valid).
 */
export function validateSeed(files) {
  const errs = [
    ...validateManifest(files["manifest.json"]),
    ...validateExperts(files["experts.json"]),
    ...validateItems(files["items.json"]),
    ...validateClaims(files["claims.json"]),
    ...validateClusters(files["clusters.json"]),
    ...(files["calls.json"] === undefined ? [] : validateCalls(files["calls.json"])),
    ...(files["licence-check.json"] === undefined
      ? []
      : validateLicenceCheck(files["licence-check.json"])),
    ...(files["call-proposals.json"] === undefined
      ? []
      : validateCallProposals(files["call-proposals.json"])),
    ...(files["expressions.json"] === undefined
      ? []
      : validateExpressions(files["expressions.json"])),
  ];
  if (files["manifest.json"]?.format === FORMAT) {
    for (const name of ["licence-check.json", "call-proposals.json", "expressions.json"]) {
      if (files[name] !== undefined) errs.push(`${name}: $: file needs format ${FORMAT_V2}`);
    }
  }
  if (errs.length > 0) return errs;
  const e = collector();
  const experts = new Set(files["experts.json"].experts.map((x) => x.id));
  const itemKeys = new Set(
    files["items.json"].items.filter((x) => (x.content_hash ?? null) === null).map((x) => x.url),
  );
  const claims = new Map(files["claims.json"].claims.map((x) => [x.id, x]));
  const clusters = new Set(files["clusters.json"].clusters.map((x) => x.id));
  files["items.json"].items.forEach((x, i) =>
    e.check("items.json", `items[${i}].expert_id`, experts.has(x.expert_id), "unknown expert"),
  );
  files["claims.json"].claims.forEach((x, i) => {
    x.experts.forEach((k, n) =>
      e.check("claims.json", `claims[${i}].experts[${n}]`, experts.has(k), "unknown expert"),
    );
    (x.items ?? []).forEach((u, n) =>
      e.check(
        "claims.json",
        `claims[${i}].items[${n}]`,
        itemKeys.has(u),
        "no such item in items.json",
      ),
    );
    if (x.cluster_id !== undefined && x.cluster_id !== null) {
      e.check(
        "claims.json",
        `claims[${i}].cluster_id`,
        clusters.has(x.cluster_id),
        "unknown cluster",
      );
    }
  });
  files["clusters.json"].clusters.forEach((x, i) => {
    for (const role of ["supports", "contradicts"]) {
      (x[role] ?? []).forEach((c, n) =>
        e.check("clusters.json", `clusters[${i}].${role}[${n}]`, claims.has(c), "unknown claim"),
      );
    }
  });
  (files["licence-check.json"]?.results ?? []).forEach((x, i) =>
    e.check(
      "licence-check.json",
      `results[${i}].expert_id`,
      experts.has(x.expert_id),
      "unknown expert",
    ),
  );
  (files["call-proposals.json"]?.proposals ?? []).forEach((x, i) => {
    const c = claims.get(x.claim_id);
    const w = `proposals[${i}].claim_id`;
    e.check("call-proposals.json", w, c !== undefined, "unknown claim");
    if (c !== undefined)
      e.check("call-proposals.json", w, c.type === "call", "claim is not of type call");
  });
  const clusterRows = new Map(files["clusters.json"].clusters.map((x) => [x.id, x]));
  (files["expressions.json"]?.expressions ?? []).forEach((x, i) => {
    const k = clusterRows.get(x.cluster_id);
    const w = `expressions[${i}].cluster_id`;
    e.check("expressions.json", w, k !== undefined, "unknown cluster");
    if (k !== undefined)
      e.check(
        "expressions.json",
        w,
        !k.family_fit,
        "cluster has a family fit; it is screened as a fit",
      );
  });
  (files["calls.json"]?.calls ?? []).forEach((x, i) => {
    const c = claims.get(x.claim_id);
    e.check("calls.json", `calls[${i}].claim_id`, c !== undefined, "unknown claim");
    if (c !== undefined)
      e.check("calls.json", `calls[${i}].claim_id`, c.type === "call", "claim is not of type call");
  });
  return e.list;
}
