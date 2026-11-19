// The market's public split, consolidation and bonus-issue ratios for the codes of a trade log (M21 B3; D-1268). This is
// market data (`corporate_action`, confirmed actions only), not Owner data. The ratio is the engine's own `quantityRatio`.
// Bounded: codes in chunks, keyset by action id, an id list for the confirmation check. No OFFSET.
import type { Client } from "@libsql/client";
import { stateOf } from "@/lib/data/corporateActions/rules.mjs";
import { quantityRatio } from "@/lib/arena/corpActions";
import type { Split } from "./types";

const CHUNK = 50;
const PAGE = 200;
const MAX_PAGES = 20;

export async function loadMarketSplits(
  db: Client,
  market: string,
  codes: readonly string[],
  end: string,
): Promise<Split[]> {
  const out: Split[] = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK);
    let after = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // rows-ok: market and code list, three types, keyset by id, LIMIT PAGE
      const r = await db.execute({
        sql: `SELECT id, code, type, ex_date, payload_json FROM corporate_action
              WHERE market = ? AND code IN (${part.map(() => "?").join(",")})
                AND type IN ('split','consolidation','bonus_issue') AND ex_date <= ? AND id > ?
              ORDER BY id LIMIT ?`,
        args: [market, ...part, end, after, PAGE],
      });
      if (r.rows.length > 0) {
        const ids = r.rows.map((x) => Number(x.id));
        // rows-ok: events of at most PAGE actions
        const ev = await db.execute({
          sql: `SELECT action_id, status, note FROM corporate_action_event
                WHERE action_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
          args: ids,
        });
        const newest = new Map<string, { status: string; note: string | null }>();
        for (const e of ev.rows) {
          newest.set(String(e.action_id), {
            status: String(e.status),
            note: e.note === null ? null : String(e.note),
          });
        }
        for (const x of r.rows) {
          const id = String(x.id);
          if (stateOf(newest.get(id)).state !== "confirmed") continue;
          let payload: unknown;
          try {
            payload = JSON.parse(String(x.payload_json));
          } catch {
            continue;
          }
          try {
            const ratio = quantityRatio({
              id,
              code: String(x.code),
              type: String(x.type),
              exDate: String(x.ex_date),
              payload: payload !== null && typeof payload === "object" ? (payload as never) : {},
            });
            out.push({ code: String(x.code), exD: String(x.ex_date), ratio });
          } catch {
            // an action with a bad payload is left out (the engine refuses it too)
          }
        }
      }
      if (r.rows.length < PAGE) break;
      after = Number(r.rows[r.rows.length - 1]!.id);
    }
  }
  return out;
}
