// Bake-off results for the Usage page (LLM-042, M8 T5; D-084, D-112). Owner only, like the rest of the LLM
// section. Reads the stored `bakeoff_result` rows of the LATEST run (run ids are `bakeoff-<date>-<sha8>`,
// so the highest id is the newest) and nothing else: no prompts, no model text, no keys. The markdown
// report itself is committed by the Owner; its sha is shown so the two can be matched. No run yet gives
// null ("no bake-off has run"). Read only; bounded.
import type { Client } from "@libsql/client";

const MAX_ROWS = 200; // threshold-ok: bounded rows per table

export type BakeoffLine = {
  modelId: string;
  /** A golden category, or "overall". */
  category: string;
  items: number;
  jsonValidPct: number;
  inventedNumbers: number;
  injectionResistancePct: number;
  detectionPct: number | null;
  triageAgreementPct: number | null;
  passes: boolean;
  trainsOnPromptsCheckedD: string | null;
};

export type BakeoffView = {
  runId: string;
  reportSha: string;
  lines: BakeoffLine[];
};

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v); // money-float-ok: a percentage or count stored by the bake-off
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v)); // money-float-ok: percentage

export async function loadBakeoffResults(
  db: Pick<Client, "execute">,
  role: string | null | undefined,
): Promise<BakeoffView | null> {
  if (role !== "owner") return null;
  const latest = await db.execute("SELECT MAX(run_id) AS run_id FROM bakeoff_result");
  const runId = latest.rows[0]?.run_id;
  if (runId === null || runId === undefined) return null;
  const rs = await db.execute({
    sql: `SELECT * FROM bakeoff_result WHERE run_id = ? ORDER BY model_id, category LIMIT ?`,
    args: [String(runId), MAX_ROWS],
  });
  const rows: Row[] = rs.rows.map((r) => ({ ...r }));
  return {
    runId: String(runId),
    reportSha: String(rows[0]?.report_sha ?? ""),
    lines: rows.map((r) => ({
      modelId: String(r.model_id),
      category: String(r.category),
      items: num(r.items),
      jsonValidPct: num(r.json_valid_pct),
      inventedNumbers: num(r.invented_numbers),
      injectionResistancePct: num(r.injection_resistance_pct),
      detectionPct: optNum(r.detection_pct),
      triageAgreementPct: optNum(r.triage_agreement_pct),
      passes: num(r.passes) === 1,
      trainsOnPromptsCheckedD:
        r.trains_on_prompts_checked_d === null ? null : String(r.trains_on_prompts_checked_d),
    })),
  };
}
