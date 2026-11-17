// CXA-007 store (M23 T3; D-1637, D-1735, D-1736). The only writer of the proposals: it writes `angle_proposal` rows, one
// `trial_ledger` row (kind `new_lineage`) for each STORED proposal, and one Owner-read `app_log` line. Nothing else: no card,
// pick, ranking, rule, challenger, config or e-mail table is touched, and nothing in trading reads these rows (PRD-033).
// A stored row keeps the checked rule in canonical form and the name next to it; a refused row keeps its state only, never any
// text of the item. All of a night's rows go in one batch, so a proposal and its charge are written together or not at all.
import type { Client, InStatement } from "@libsql/client";
import { canonicalJson, sha256Hex } from "../registry";
import type { Known, Verdict } from "./validate";
import { nameKey, ruleShaOf } from "./validate";
import { PROPOSAL_KINDS, type ProposalKind } from "./schema";

const ID_PREFIX_CHARS = 12; // threshold-ok: characters of the proposal id in the charged lineage name
const MODEL_ID_MAX = 128; // threshold-ok: model_id column cap (0043)
const KNOWN_ROWS = 300; // threshold-ok: bound on the earlier proposals and rule versions read for the duplicate check
const LOG_SOURCE = "research";

export const LINEAGE_PREFIX = "llm_proposal_";

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The id of one proposal: the month, the market, its place in the answer and a hash of the item as it came (hash only). */
export function proposalId(market: string, month: string, index: number, raw: unknown): string {
  let text = "null";
  try {
    text = canonicalJson(raw);
  } catch {
    text = "unreadable";
  }
  return sha256Hex(`angle-proposal-1|${market}|${month}|${index}|${text}`);
}

export const lineageOf = (id: string): string => `${LINEAGE_PREFIX}${id.slice(0, ID_PREFIX_CHARS)}`;

/** The rules and names already on file: earlier stored proposals and every registered rule version of the market. */
export async function knownFor(
  db: Client,
  market: string,
  angleNames: Set<string>,
): Promise<Known> {
  const ruleShas = new Set<string>();
  const names = new Set<string>(angleNames);
  // rows-ok: the market's stored proposals, at most ten a month; LIMIT bounds it
  const prior = await db.execute({
    sql:
      "SELECT rule_json FROM angle_proposal WHERE market = ? AND state = 'stored' " +
      "ORDER BY created_at DESC LIMIT ?",
    args: [market, KNOWN_ROWS],
  });
  for (const r of prior.rows) {
    try {
      const v: unknown = JSON.parse(String(r.rule_json));
      if (isObj(v)) {
        if (isObj(v.rule)) ruleShas.add(ruleShaOf(v.rule));
        if (typeof v.name === "string") names.add(nameKey(v.name));
      }
    } catch {
      // an unreadable earlier row is skipped: it cannot match anything
    }
  }
  // rows-ok: the market's rule versions (a few dozen in all); LIMIT bounds it; read once a month
  const rules = await db.execute({
    sql: "SELECT spec_json FROM rule_version WHERE market = ? ORDER BY id DESC LIMIT ?",
    args: [market, KNOWN_ROWS],
  });
  for (const r of rules.rows) {
    try {
      ruleShas.add(ruleShaOf(JSON.parse(String(r.spec_json))));
    } catch {
      // skipped, as above
    }
  }
  return { ruleShas, names };
}

/** True when proposals of this market and month are already on file (the job runs once a month). */
export async function monthDone(db: Client, market: string, month: string): Promise<boolean> {
  // rows-ok: one row on the (market, month) index, LIMIT 1
  const r = await db.execute({
    sql: "SELECT 1 FROM angle_proposal WHERE market = ? AND month = ? LIMIT 1",
    args: [market, month],
  });
  return r.rows.length > 0;
}

export type StoreInput = {
  readonly market: string;
  readonly month: string;
  /** The session date the stored proposals are charged to. */
  readonly d: string;
  readonly now: string;
  readonly modelId: string | null;
  readonly raws: readonly unknown[];
  readonly verdicts: readonly Verdict[];
};

export type StoreResult = {
  readonly stored: number;
  readonly refused: Readonly<Record<string, number>>;
};

/** Writes the whole answer in one batch: the rows, the charges of the stored ones and one plain log line. */
export async function storeVerdicts(db: Client, x: StoreInput): Promise<StoreResult> {
  const stmts: InStatement[] = [];
  const refused: Record<string, number> = {};
  let stored = 0;
  const model = x.modelId === null ? null : x.modelId.slice(0, MODEL_ID_MAX);
  x.verdicts.forEach((v, i) => {
    const id = proposalId(x.market, x.month, i, x.raws[i]);
    if (v.state === "stored") {
      stored += 1;
      const e = v.envelope;
      stmts.push({
        // rows-ok: one proposal row, keyed by its id
        sql:
          "INSERT OR IGNORE INTO angle_proposal (proposal_id, market, month, kind, state, rule_json, orientation, " +
          "cluster, evidence_json, model_id, created_at) VALUES (?, ?, ?, ?, 'stored', ?, ?, ?, ?, ?, ?)",
        args: [
          id,
          x.market,
          x.month,
          e.kind,
          canonicalJson({ name: e.name, rule: e.rule }),
          e.orientation,
          e.cluster,
          canonicalJson(e.evidence),
          model,
          x.now,
        ],
      });
      stmts.push({
        // rows-ok: one charge for the stored proposal, keyed by an id made from the proposal id (K16)
        sql:
          "INSERT OR IGNORE INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d) " +
          "VALUES (?, ?, ?, 0, 'new_lineage', NULL, ?, NULL, ?)",
        args: [`proposal:${id}`, x.market, lineageOf(id), e.kind, x.d],
      });
    } else {
      refused[v.state] = (refused[v.state] ?? 0) + 1;
      const raw = x.raws[i];
      const kind: ProposalKind =
        isObj(raw) && (PROPOSAL_KINDS as readonly unknown[]).includes(raw.kind)
          ? (raw.kind as ProposalKind)
          : "angle";
      stmts.push({
        // rows-ok: one refused row, keyed by its id; no rule and no text of the item
        sql:
          "INSERT OR IGNORE INTO angle_proposal (proposal_id, market, month, kind, state, model_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [id, x.market, x.month, kind, v.state, model, x.now],
      });
    }
  });
  const refusedTotal = Object.values(refused).reduce((a, b) => a + b, 0);
  stmts.push({
    // rows-ok: one Owner-read line for the monthly run
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'info', ?, ?, NULL)",
    args: [
      x.now,
      LOG_SOURCE,
      `The monthly model-written proposals were checked: ${stored} kept for you to review, ${refusedTotal} refused. Nothing in the book changed.`,
    ],
  });
  await db.batch(stmts, "write");
  return { stored, refused };
}
