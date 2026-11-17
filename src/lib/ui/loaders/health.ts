// Control Room loader (UX-090..092, UXN-283, UXN-285; docs/M7_design.md 3 row 26; D-136 draft).
// "n / 9 healthy" comes from the same pure `computeComponents` that the reminder and the Evening Review
// use, so the page cannot disagree with them. Every role sees component states and one-line reasons;
// the fix lines, deadlines and links (details) are Owner-only (ROL-102a). For a masked user the
// reasons pass through maskText with an empty active set, so no code or company name can appear.
import { computeComponents, type ComponentResult } from "@/lib/health/components";
import { gatherHealthFacts } from "@/lib/health/snapshot";
import { loadExpertsHealth, type ExpertsHealth } from "@/lib/health/experts";
import { loadSteelmanHealth, type SteelmanHealth } from "@/lib/health/steelman";
import { loadLlmRoutesHealth } from "@/lib/health/llmRoutes";
import { loadCommitteeHealth } from "@/lib/health/committee";
import { loadOpinionsHealth } from "@/lib/health/opinions";
import { loadMinilmHealth } from "@/lib/health/minilm";
import { loadRegimeAltHealth } from "@/lib/health/regimeAlt";
import { loadResearchHealth } from "@/lib/health/research";
import { loadMaskLookup, maskText, StockAliases } from "@/lib/view/mask";
import { todayD, type LoaderEnv, type LoaderState } from "./shell";

const STRIP_DAYS = 30; // threshold-ok: decision 60, 30-day strip
export const COMPONENT_COUNT = 9; // threshold-ok: UXN-283, nine components

export type HealthComponentView = {
  id: string;
  state: ComponentResult["state"];
  reason: string;
  items: Array<{
    key: string;
    label: string;
    state: string;
    deadlineD: string | null;
    fix: string;
    fixPath: string;
  }>;
};
export type HealthModel = {
  state: LoaderState;
  masked: boolean;
  healthy: number;
  total: number;
  /** "n / 9 healthy" */
  headline: string;
  components: HealthComponentView[];
  /** One entry per stored day, oldest first: healthy components that day. */
  strip: Array<{ d: string; healthy: number; total: number }>;
  details: boolean;
  /** BLD-041 evidence line (D-493); text only, no code or name, so it needs no masking. */
  steelman: SteelmanHealth;
  /** M13-lite line (D-518, D-624); text only, no code or name. */
  experts: ExpertsHealth;
  /**
   * M22 lines (D-1446), plain words: the AI jobs that are switched on (Owner only), the Committee trial,
   * the bull and bear meters, the small reader and the outside-signals reading. Dates go through the mask.
   */
  m22: { state: "ok" | "attention"; lines: string[] };
};

/**
 * D-652: the experts line carries the last screening date; a masked viewer sees every date as an ISO week
 * (D-147, D-615), which `maskText` already does for the component reasons, so the line goes through it too.
 */
export const maskExpertsHealth = (x: ExpertsHealth, t: (s: string) => string): ExpertsHealth => ({
  ...x,
  lastScreening: x.lastScreening === null ? null : t(x.lastScreening),
  text: t(x.text),
});

/** The M22 health lines for one role; a viewer without the Owner role sees no AI-jobs line. */
async function loadM22Lines(
  env: LoaderEnv,
  owner: boolean,
  t: (s: string) => string,
): Promise<HealthModel["m22"]> {
  const routes = owner ? await loadLlmRoutesHealth(env.main) : null;
  const committee = await loadCommitteeHealth(env.main, env.market);
  const opinions = await loadOpinionsHealth(env.main, env.market);
  const minilm = await loadMinilmHealth(env.main);
  const alt = await loadRegimeAltHealth(env.main);
  const research = owner ? await loadResearchHealth(env.main) : null;
  const parts = [routes, committee, opinions, minilm, alt, research].filter((x) => x !== null);
  return {
    state: parts.some((p) => p.state === "attention") ? "attention" : "ok",
    lines: [
      ...(routes?.lines ?? []),
      committee.text,
      ...opinions.lines,
      minilm.line,
      alt.line,
      ...(research === null ? [] : [research.line]),
    ].map(t),
  };
}

export async function loadHealth(
  env: LoaderEnv,
  vars: Record<string, string | undefined> = process.env,
): Promise<HealthModel> {
  const owner = env.user.role === "owner";
  const facts = await gatherHealthFacts(env.main, env.now, todayD(env), vars);
  const comps = computeComponents(facts);
  const lookup = env.mask.masked ? await loadMaskLookup(env.main, env.market) : null;
  const empty = new StockAliases([]);
  const t = (s: string): string => (lookup ? maskText(s, empty, lookup) : s);
  const components: HealthComponentView[] = comps.map((c) => ({
    id: c.id,
    state: c.state,
    reason: t(c.reason),
    items: owner
      ? c.items.map((i) => ({
          key: i.key,
          label: i.label,
          state: i.state,
          deadlineD: i.deadline_d,
          fix: i.fix,
          fixPath: i.fix_path,
        }))
      : [],
  }));
  const healthy = comps.filter((c) => c.state === "healthy").length;
  let strip: HealthModel["strip"] = [];
  try {
    const r = await env.main.execute({
      sql: `SELECT d, components_json FROM health_snapshot WHERE purpose = 'reminder'
            ORDER BY d DESC LIMIT ?`,
      args: [STRIP_DAYS],
    });
    strip = r.rows
      .map((x) => {
        try {
          const v = JSON.parse(String(x.components_json)) as {
            components?: Array<{ state?: string }>;
          };
          const list = Array.isArray(v.components) ? v.components : [];
          return {
            d: String(x.d),
            healthy: list.filter((c) => c.state === "healthy").length,
            total: list.length,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is { d: string; healthy: number; total: number } => x !== null)
      .reverse();
  } catch {
    strip = [];
  }
  return {
    state: !facts.dbReadable ? "stale" : "ok",
    masked: env.mask.masked,
    healthy,
    total: comps.length,
    headline: `${healthy} / ${comps.length} healthy`,
    components,
    strip,
    details: owner,
    steelman: await loadSteelmanHealth(env.main, env.market),
    experts: maskExpertsHealth(await loadExpertsHealth(env.main, env.market), t),
    m22: await loadM22Lines(env, owner, t),
  };
}
