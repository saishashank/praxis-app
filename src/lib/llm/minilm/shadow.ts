// The MiniLM shadow stage (M22 L5, LLM-079, D-1416): the night's announcements are read by the small local classifier next to the
// rule classifier, and the two answers are stored side by side in `minilm_shadow` (append-only). Nothing reads that table
// to decide anything (reader test); the night's agreement figure is computed from it for the health line and the run summary.
// Bounded: at most `cap` (news_assess_per_run) rows per market and day, one keyset read. Off, not ready or without an
// embedder it writes nothing. Idempotent: an announcement already stored for the day is not read again.
import type { Client } from "@libsql/client";
import { classifyAnnouncement } from "@/lib/agents/events";
import type { Embedder } from "./embed";
import { predict, readinessProblem, type Head, type MinilmLock } from "./head";

type Exec = Pick<Client, "execute" | "batch">;

/** A category other than "other" counts as material for the comparison, for the rules and for the model alike (D-1500). */
export const isMaterialCategory = (category: string): boolean => category !== "other";

export type ShadowStatus = "written" | "off" | "not_ready" | "unavailable" | "nothing";

export type Agreement = {
  /** Rows stored for the day. */
  rows: number;
  /** Rows where both readers chose the same category. */
  agree: number;
  /** Rows where both readers agreed on material or not. */
  materialAgree: number;
};

export type ShadowResult = {
  status: ShadowStatus;
  /** Plain reason when the status is not_ready or unavailable. */
  reason: string | null;
  /** Rows written by this run. */
  written: number;
  agreement: Agreement;
};

export type ShadowInput = {
  market: string;
  /** The market date of the night, YYYY-MM-DD. */
  d: string;
  /** `minilm_enabled` is "on". */
  enabled: boolean;
  /** `news_assess_per_run`: the most rows stored for the night. */
  cap: number;
  head: Head;
  lock: MinilmLock;
  /** Null when the model could not be loaded. */
  embedder: Embedder | null;
  /** ISO timestamp stamped on the rows. */
  now: string;
};

const nextDay = (d: string): string => {
  const t = Date.parse(`${d}T00:00:00Z`) + 86_400_000; // threshold-ok: milliseconds in a day
  return new Date(t).toISOString().slice(0, 10); // threshold-ok: length of an ISO date
};

/** The text the model reads: the exchange's type words and the title (no body is stored or read). */
export const textOf = (type: string | null, title: string): string =>
  type !== null && type.trim() !== "" ? `${type.trim()}. ${title}` : title;

/** The night's agreement figure from the stored rows (at most `cap` rows, the primary key prefix). */
export async function agreementOf(
  db: Pick<Client, "execute">,
  market: string,
  d: string,
): Promise<Agreement> {
  // rows-ok: minilm_shadow primary key (market, d, ...) prefix, one aggregate row, at most news_assess_per_run rows read
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n, COALESCE(SUM(rule_category = model_category), 0) AS a,
                 COALESCE(SUM(rule_material = model_material), 0) AS m
            FROM minilm_shadow WHERE market = ? AND d = ?`,
    args: [market, d],
  });
  const row = r.rows[0];
  return {
    rows: Number(row?.n ?? 0),
    agree: Number(row?.a ?? 0),
    materialAgree: Number(row?.m ?? 0),
  };
}

/** Classifies tonight's announcements with the head and stores them beside the rule classifier's answer. Never throws on a model fault. */
export async function shadowNight(db: Exec, x: ShadowInput): Promise<ShadowResult> {
  const result = async (
    status: ShadowStatus,
    reason: string | null,
    written: number,
  ): Promise<ShadowResult> => ({
    status,
    reason,
    written,
    agreement: await agreementOf(db, x.market, x.d),
  });
  if (!x.enabled) return result("off", null, 0);
  const problem = readinessProblem(x.head, x.lock);
  if (problem !== null) return result("not_ready", problem, 0);
  if (
    x.embedder === null ||
    x.embedder.dim !== x.head.dim ||
    x.embedder.modelSha !== x.head.modelSha
  )
    return result("unavailable", "the model is not available", 0);

  const have = (await agreementOf(db, x.market, x.d)).rows;
  const room = Math.max(0, Math.min(Math.trunc(x.cap), 200) - have); // threshold-ok: hard ceiling on one night's announcements read, a read bound
  if (room === 0) return result("nothing", null, 0);

  // rows-ok: announcement idx_announcement_published range for one day, anti-join on the minilm_shadow primary key, ORDER BY id, LIMIT room (at most news_assess_per_run)
  const rs = await db.execute({
    sql: `SELECT a.source, a.ann_id, a.type, a.title FROM announcement a
           WHERE a.market = ? AND a.published_at >= ? AND a.published_at < ?
             AND NOT EXISTS (SELECT 1 FROM minilm_shadow m WHERE m.market = a.market AND m.d = ?
                               AND m.source = a.source AND m.ann_id = a.ann_id)
           ORDER BY a.id LIMIT ?`,
    args: [x.market, x.d, nextDay(x.d), x.d, room],
  });
  const items = rs.rows.map((r) => ({
    source: String(r.source),
    annId: String(r.ann_id),
    type: r.type === null ? null : String(r.type),
    title: String(r.title),
  }));
  if (items.length === 0) return result("nothing", null, 0);

  let vectors: number[][];
  try {
    vectors = await x.embedder.embed(items.map((i) => textOf(i.type, i.title)));
    if (vectors.length !== items.length) throw new Error("count");
  } catch {
    return result("unavailable", "the model could not read the announcements", 0);
  }

  const stmts = items.map((it, i) => {
    const rule = classifyAnnouncement(it.type, it.title).category;
    const model = predict(x.head, vectors[i]!).label;
    return {
      // rows-ok: minilm_shadow primary key (market, d, source, ann_id), at most news_assess_per_run rows in one batch
      sql: `INSERT OR IGNORE INTO minilm_shadow (market, d, source, ann_id, rule_category, model_category,
              rule_material, model_material, model_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        x.market,
        x.d,
        it.source,
        it.annId,
        rule,
        model,
        isMaterialCategory(rule) ? 1 : 0,
        isMaterialCategory(model) ? 1 : 0,
        x.embedder!.modelSha,
        x.now,
      ],
    };
  });
  await db.batch(stmts, "write");
  return result("written", null, items.length);
}

/** One plain line for the run summary (counts only, no text). */
export function shadowSummary(market: string, d: string, r: ShadowResult): string {
  const a = r.agreement;
  const why = r.reason === null ? "" : ` (${r.reason})`;
  return (
    `minilm-shadow ${market} ${d}: ${r.status}${why} written=${r.written}` +
    ` rows=${a.rows} agree=${a.agree} material_agree=${a.materialAgree}`
  );
}
