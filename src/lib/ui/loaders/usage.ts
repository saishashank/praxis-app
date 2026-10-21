// Usage loader (UX-100, LLM-051, PLT-050/051; docs/M7_design.md 3 row 27; D-136 draft). Owner only
// (ROL-102a): the loader refuses any other role itself (returns null), on top of the page guard.
// Meters come from `getMeters`; the LLM section is read from `llm_call` for the last 30 days, grouped
// by role and provider (counts and tokens only; no prompts or text are stored there).
import { getMeters, usageEnvironment, worstMeter, type Meter } from "@/lib/usage/meters";
import { marketOf, type LoaderEnv, type LoaderState } from "./shell";

const LLM_DAYS = 30; // threshold-ok: LLM-051 view window
const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const LLM_GROUPS = 50; // threshold-ok: bounded rows

export type LlmUsageRow = {
  role: string;
  provider: string;
  calls: number;
  cached: number;
  rulesOnly: number;
  tokensIn: number;
  tokensOut: number;
};
export type UsageModel = {
  state: LoaderState;
  worst: { level: string; label: string | null };
  meters: Meter[];
  llm: { sinceD: string; rows: LlmUsageRow[] };
};

export async function loadUsage(
  env: LoaderEnv,
  vars: Record<string, string | undefined> = process.env,
): Promise<UsageModel | null> {
  if (env.user.role !== "owner") return null;
  const meters = await getMeters(env.main, env.now, usageEnvironment(vars));
  const worst = worstMeter(meters);
  const sinceD = new Date(env.now.getTime() - LLM_DAYS * DAY_MS).toISOString().slice(0, 10);
  const r = await env.main.execute({
    sql: `SELECT role, provider, COUNT(*) AS calls, SUM(cached) AS cached,
                 SUM(CASE WHEN fallback_depth = 'rules-only' THEN 1 ELSE 0 END) AS rules_only,
                 SUM(tokens_in) AS tin, SUM(tokens_out) AS tout
          FROM llm_call WHERE market = ? AND d >= ? GROUP BY role, provider
          ORDER BY calls DESC, role LIMIT ?`,
    args: [marketOf(env), sinceD, LLM_GROUPS],
  });
  return {
    state: meters.every((m) => m.level === "no data") && r.rows.length === 0 ? "empty" : "ok",
    worst: { level: worst.level, label: worst.meter?.label ?? null },
    meters,
    llm: {
      sinceD,
      rows: r.rows.map((x) => ({
        role: String(x.role),
        provider: String(x.provider),
        calls: Number(x.calls), // money-float-ok: SQL count
        cached: Number(x.cached ?? 0), // money-float-ok: SQL count
        rulesOnly: Number(x.rules_only ?? 0), // money-float-ok: SQL count
        tokensIn: Number(x.tin ?? 0), // money-float-ok: SQL count
        tokensOut: Number(x.tout ?? 0), // money-float-ok: SQL count
      })),
    },
  };
}
