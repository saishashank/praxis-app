// Owner-run import of the expert seed (M13-lite WP3; D-510, D-512, D-513, D-520, D-521, D-531, D-536, D-540).
//   node scripts/experts/import.mjs <seed-folder> [--dry-run]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN (a file: URL needs no token). Output: counts only, never a row, a
// name, a URL or a token. The folder is private data and must lie OUTSIDE this repository (SEC-110).
// The format `praxis-expert-seed/1` is documented in scripts/experts/README.md and enforced by validate.mjs.
// No network request and no LLM call is made anywhere (O-64). Re-running is safe (insert-or-ignore on every
// key; the append-only chain rows are inserted only when their seq 1 is missing).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { FORMAT, validateSeed } from "./validate.mjs";

export { FORMAT };
export const MIN_SCHEMA = 22;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED = ["manifest.json", "experts.json", "items.json", "claims.json", "clusters.json"];
const OPTIONAL = ["calls.json"];
const ACTOR = "seed";

/** Sorted-key JSON text, the same as the Cortex importer writes into JSON columns. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** source_item.id (0022): lower-case 64-hex sha256 of url + '|' + (content_hash ?? ''). */
export function itemId(url, contentHash) {
  return createHash("sha256")
    .update(`${url}|${contentHash ?? ""}`)
    .digest("hex");
}

/** True when `dir` lies inside the repository (private seeds must not). */
export function insideRepo(dir) {
  const rel = path.relative(REPO_ROOT, path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Reads and validates the seed folder; the errors name file and path, never a value. */
export function loadSeed(dir) {
  const errs = [];
  const data = {};
  for (const name of [...REQUIRED, ...OPTIONAL]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      if (REQUIRED.includes(name)) errs.push(`${name}: $: file missing`);
      continue;
    }
    try {
      data[name] = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      errs.push(`${name}: $: not valid JSON`);
    }
  }
  if (errs.length > 0) return { ok: false, errors: errs, data };
  const verr = validateSeed(data);
  return { ok: verr.length === 0, errors: verr, data };
}

/** Builds the ordered statement list (D-536 import order). Pure. */
export function plan(data) {
  const m = data["manifest.json"];
  const market = m.market;
  const at = m.created_at;
  const stmts = [];
  const ins = (table, tag, cols, args) =>
    stmts.push({
      tag,
      sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
      args,
    });
  // Chain rows (seq 1) are triggered by a "next seq" guard that fires BEFORE the conflict is resolved, so a
  // plain insert would abort on a re-run: insert only when seq 1 is missing.
  const chain = (table, tag, keyCol, key, cols, args) =>
    stmts.push({
      tag,
      sql: `INSERT INTO ${table} (${keyCol}, seq, ${cols.join(", ")}) SELECT ?, 1, ${cols.map(() => "?").join(", ")} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND seq = 1)`,
      args: [key, ...args, key],
    });

  const experts = data["experts.json"].experts;
  const items = data["items.json"].items;
  const claims = data["claims.json"].claims;
  const clusters = data["clusters.json"].clusters;
  const calls = data["calls.json"]?.calls ?? [];

  for (const x of experts) {
    ins(
      "expert",
      "experts",
      [
        "id",
        "name",
        "platforms_json",
        "handles_json",
        "home_urls_json",
        "markets_json",
        "focus_json",
        "licence_status",
        "status",
        "tier",
        "no_feed",
        "audience_size",
        "audience_d",
        "created_at",
        "updated_at",
      ],
      [
        x.id,
        x.name,
        canonical(x.platforms),
        canonical(x.handles),
        canonical(x.home_urls),
        canonical(x.markets),
        canonical(x.focus),
        x.licence_status ?? "unchecked", // D-520
        x.status,
        x.tier,
        x.no_feed ? 1 : 0,
        x.audience_size ?? null,
        x.audience_d ?? null,
        at,
        at,
      ],
    );
  }
  for (const x of experts) {
    (x.red_flags ?? []).forEach((r, i) => {
      ins(
        "expert_red_flag",
        "red_flags",
        ["id", "expert_id", "text", "source_url", "noted_d", "created_at"],
        [`${x.id}:rf${i + 1}`, x.id, r.text, r.source_url, r.noted_d, at],
      );
    });
  }
  for (const x of items) {
    ins(
      "source_item",
      "items",
      [
        "id",
        "expert_id",
        "url",
        "platform",
        "title",
        "published_at",
        "ingested_at",
        "content_hash",
        "summary",
        "quote",
        "kind",
        "extraction_status",
      ],
      [
        itemId(x.url, x.content_hash),
        x.expert_id,
        x.url,
        x.platform,
        x.title ?? null,
        x.published_at ?? null,
        at,
        x.content_hash ?? null,
        x.summary ?? null,
        x.quote ?? null,
        x.kind,
        x.extraction_status,
      ],
    );
  }
  for (const c of clusters) {
    ins(
      "cluster",
      "clusters",
      [
        "id",
        "name",
        "category",
        "statement",
        "canonical_text",
        "testability",
        "external_grade",
        "evidence_links_json",
        "vocabulary_gaps",
        "closest_family",
        "family_fit_json",
        "created_at",
      ],
      [
        c.id,
        c.name,
        c.category,
        c.statement,
        c.canonical_text ?? null,
        c.testability,
        c.external_grade,
        canonical(c.evidence_links ?? []),
        c.vocabulary_gaps ?? 0,
        c.closest_family ?? null,
        c.family_fit ? canonical(c.family_fit) : null,
        at,
      ],
    );
  }
  for (const c of clusters) {
    // D-512: seed clusters start 'proposed'.
    chain(
      "cluster_state",
      "cluster_states",
      "cluster_id",
      c.id,
      ["state", "merged_into", "reason", "actor", "at"],
      ["proposed", null, null, ACTOR, at],
    );
  }
  for (const x of claims) {
    ins(
      "claim",
      "claims",
      ["id", "type", "testability", "cluster_id", "created_at"],
      [x.id, x.type, x.testability, x.cluster_id ?? null, at],
    );
  }
  for (const x of claims) {
    chain(
      "claim_revision",
      "claim_revisions",
      "claim_id",
      x.id,
      [
        "statement",
        "formalisation_text",
        "vocabulary_gap_text",
        "claimed_edge_text",
        "actor",
        "at",
      ],
      [
        x.statement,
        x.formalisation ?? null,
        x.vocabulary_gap ?? null,
        x.claimed_edge ?? null,
        ACTOR,
        at,
      ],
    );
  }
  for (const x of claims) {
    // D-512: every seed claim is 'extracted' (L0); nothing is auto-confirmed.
    chain(
      "claim_status",
      "claim_statuses",
      "claim_id",
      x.id,
      ["status", "reason", "actor", "at"],
      ["extracted", null, ACTOR, at],
    );
  }
  for (const x of claims) {
    for (const k of new Set(x.experts))
      ins("claim_expert", "claim_experts", ["claim_id", "expert_id"], [x.id, k]);
  }
  for (const x of claims) {
    for (const u of new Set(x.items ?? [])) {
      ins("claim_item", "claim_items", ["claim_id", "item_id"], [x.id, itemId(u, null)]);
    }
  }
  for (const c of clusters) {
    for (const role of ["supports", "contradicts"]) {
      for (const id of new Set(c[role] ?? [])) {
        ins(
          "claim_cluster",
          "claim_clusters",
          ["claim_id", "cluster_id", "role"],
          [id, c.id, role],
        );
      }
    }
  }
  for (const x of calls) {
    ins(
      "expert_call",
      "calls",
      [
        "claim_id",
        "market",
        "code",
        "direction",
        "call_d",
        "horizon_sessions",
        "target_micro",
        "stop_micro",
        "tracked",
        "created_at",
      ],
      [
        x.claim_id,
        x.market,
        x.code,
        x.direction,
        x.call_d,
        x.horizon_sessions,
        x.target_micro ?? null,
        x.stop_micro ?? null,
        x.tracked ? 1 : 0,
        at,
      ],
    );
  }
  return { market, stmts };
}

/** Counts per tag. */
function tally(stmts) {
  const c = {
    experts: 0,
    red_flags: 0,
    items: 0,
    clusters: 0,
    cluster_states: 0,
    claims: 0,
    claim_revisions: 0,
    claim_statuses: 0,
    claim_experts: 0,
    claim_items: 0,
    claim_clusters: 0,
    calls: 0,
  };
  for (const s of stmts) c[s.tag] += 1;
  return c;
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: (url: string, token: string | undefined) => Pick<import("@libsql/client").Client, "execute" | "batch" | "close">,
 *   out?: (s: string) => void, allowInsideRepo?: boolean }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const dry = argv.includes("--dry-run");
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    out("expert import: failed (usage: <seed-folder> [--dry-run])");
    return 1;
  }
  if (!deps.allowInsideRepo && insideRepo(dir)) {
    out(
      "expert import: failed (the seed folder must be outside the repository; it is private data)",
    );
    return 1;
  }
  if (!existsSync(dir)) {
    out("expert import: failed (seed folder not found)");
    return 1;
  }
  const loaded = loadSeed(dir);
  if (!loaded.ok) {
    out(`expert import: rejected (${loaded.errors.length} schema errors; nothing written)`);
    for (const m of loaded.errors) out(`  ${m}`);
    return 1;
  }
  const { market, stmts } = plan(loaded.data);
  const planned = tally(stmts);
  if (dry) {
    out(`expert import dry run (${market}): ${JSON.stringify(planned)}; nothing written`);
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  const has = (v) => typeof v === "string" && v.trim() !== "";
  if (!has(url) || (!has(token) && !String(url).startsWith("file:"))) {
    out("expert import: failed (database not configured)");
    return 1;
  }
  const db = openDb(String(url), token);
  try {
    let schema = 0;
    try {
      const r = await db.execute("SELECT MAX(version) AS v FROM schema_migrations");
      schema = Number(r.rows[0]?.v ?? 0);
    } catch {
      schema = 0;
    }
    if (schema < MIN_SCHEMA) {
      out(`expert import: refused (database schema ${schema} is below ${MIN_SCHEMA})`);
      return 1;
    }
    // One batch = one transaction; a refusal anywhere rolls the whole seed back.
    const results = await db.batch(
      stmts.map((x) => ({ sql: x.sql, args: x.args })),
      "write",
    );
    const written = Object.fromEntries(Object.keys(planned).map((k) => [k, 0]));
    results.forEach((r, i) => {
      written[stmts[i].tag] += r.rowsAffected;
    });
    const present = Object.fromEntries(
      Object.keys(planned).map((k) => [k, planned[k] - written[k]]),
    );
    out(
      `expert import (${market}): written ${JSON.stringify(written)}; already present ${JSON.stringify(present)}`,
    );
    return 0;
  } catch {
    out("expert import: failed (the database refused the write; nothing was written)");
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
