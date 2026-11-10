// Names for the Evening Review (D-922): strategy names by family and company names by code, so the
// review never prints E01 / F1-U / a bare code. Read-only; a failing read gives the fallback.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { STRATEGY_NAMES_DEFAULT } from "@/lib/config/keys";
import { displayName } from "@/lib/view/format";

type Db = Pick<Client, "execute">;

const CHUNK = 200; // threshold-ok: bound parameters per IN list

/** Strategy name by family ("F1" -> "Follow the trend"): the stored table, else the default table. */
export async function familyNames(db: Pick<Client, "execute">): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [fam, row] of Object.entries(STRATEGY_NAMES_DEFAULT)) out[fam] = row.name;
  try {
    const stored = await getConfig(db, "strategy_names");
    if (typeof stored === "object" && stored !== null) {
      for (const [fam, row] of Object.entries(stored as Record<string, unknown>)) {
        const r = row as { name?: unknown } | null;
        if (r && typeof r.name === "string" && r.name.length > 0 && fam in out) out[fam] = r.name;
      }
    }
  } catch {
    // the default table stays
  }
  return out;
}

/** Company names (display form) by code. A code without a row is simply absent. */
export async function companyNames(
  db: Db,
  market: string,
  codes: Iterable<string>,
): Promise<Map<string, string>> {
  const all = [...new Set(codes)].filter((c) => c !== "" && c !== "-");
  const out = new Map<string, string>();
  for (let i = 0; i < all.length; i += CHUNK) {
    const part = all.slice(i, i + CHUNK);
    try {
      const r = await db.execute({
        sql: `SELECT code, name FROM instrument WHERE market = ? AND code IN (${part.map(() => "?").join(",")})`,
        args: [market, ...part],
      });
      for (const x of r.rows) out.set(String(x.code), displayName(String(x.name)));
    } catch {
      // names are optional decoration
    }
  }
  return out;
}
