// The `full` mode interlock (M8 T11, docs/M8_design.md decision 33; D-155). HIGH RISK: `full` is the
// switch that turns on real paper trading. Rule: in PRODUCTION a market may be set to `full` only
// when (1) a `go_live_signoff` row exists for it (written by the Owner on /ops/go-live after every
// checklist item) and (2) `email_mode` is not `off`. STAGING is free (AT-28 needs it). Anything that
// is not positively identified as staging is treated as production (fail closed).
import type { Client, Transaction } from "@libsql/client";
import { readEmailSwitch } from "@/lib/email/switch";
import { deriveEnv } from "@/lib/selfcheck/checks";

type Exec = Pick<Client, "execute"> | Pick<Transaction, "execute">;

export type FullRefusal = "signoff_required" | "email_off";

/** True unless the deployment is positively staging (selfcheck deriveEnv: production wins). */
export function isProductionEnv(env: Record<string, string | undefined>): boolean {
  return deriveEnv(env) !== "staging";
}

/** True when any market is in full mode (email cannot be switched off then, in production). */
export async function anyMarketFull(db: Exec): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM market WHERE mode = 'full' LIMIT 1",
    args: [],
  });
  return r.rows.length > 0;
}

export async function hasSignoff(db: Exec, market: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM go_live_signoff WHERE market = ? LIMIT 1",
    args: [market],
  });
  return r.rows.length > 0;
}

/**
 * null = `full` may be set; else the refusal code. Staging is never refused. Throws on a database
 * error (the caller turns that into `unavailable`, changing nothing).
 */
export async function fullModeRefusal(
  db: Exec,
  env: Record<string, string | undefined>,
  market: string,
  today: string,
): Promise<FullRefusal | null> {
  if (!isProductionEnv(env)) return null;
  if (!(await hasSignoff(db, market))) return "signoff_required";
  const sw = await readEmailSwitch(db as Pick<Client, "execute">, today);
  return sw.mode === "off" ? "email_off" : null;
}
