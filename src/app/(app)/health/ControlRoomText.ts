// Fixed texts of the Control Room (UXN-283). The briefing is a template over stored health facts:
// never written by an LLM (LLM-034). Pure functions, no clock, no database.
import type { HealthComponentView } from "@/lib/ui/loaders/health";

export const COMPONENT_NAME: Record<string, string> = {
  sentinel: "Sentinel",
  market_data: "Market data",
  nightly_run: "Nightly run",
  ai_models: "AI models",
  evening_email: "Evening email",
  database: "Database",
  backups: "Backups",
  security: "Security",
  free_tier_limits: "Free-tier limits",
};

/** Spec references shown in the details of each part (UXN-283: "spec reference"). */
export const COMPONENT_SPEC: Record<string, string> = {
  sentinel: "PLT-061, AGT-010",
  market_data: "PLT-061, DAT-211",
  nightly_run: "PLT-017, PLT-061",
  ai_models: "PLT-061, LLM-051",
  evening_email: "PLT-061, EML-012",
  database: "PLT-061, DAT-140",
  backups: "PLT-061, OPS-020",
  security: "PLT-061, SEC-017, OPS-037",
  free_tier_limits: "PLT-050, PLT-051, NFR-005",
};

export const STATE_WORD: Record<string, string> = {
  healthy: "Healthy",
  attention: "Needs attention",
  down: "Down",
};
export const STATE_MARK: Record<string, string> = { healthy: "✓", attention: "!", down: "✕" };

export const nameOf = (id: string): string => COMPONENT_NAME[id] ?? id;
/** Anchor id of a part; matches the `fix_path` the health components already emit. */
export const anchorOf = (id: string): string => id.replace(/_/g, "-");

/** The Security reason can name a credential, so only the Owner reads it (decision 23). */
export function plainReason(c: HealthComponentView, owner: boolean): string {
  return c.id === "security" && !owner && c.state !== "healthy"
    ? "Something about secrets or releases needs the Owner."
    : c.reason;
}

const endStop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The plain-English status briefing, one sentence per line. */
export function briefingLines(
  healthy: number,
  total: number,
  components: HealthComponentView[],
  owner: boolean,
): string[] {
  const lines = [`${healthy} of ${total} parts are healthy.`];
  const bad = components.filter((c) => c.state !== "healthy");
  if (bad.length === 0) {
    lines.push("Everything is healthy. Nothing needs you today.");
    return lines;
  }
  const rank = (c: HealthComponentView): number => (c.state === "down" ? 0 : 1);
  for (const c of [...bad].sort((a, b) => rank(a) - rank(b))) {
    const verb = c.state === "down" ? "is down" : "needs attention";
    lines.push(endStop(`${nameOf(c.id)} ${verb}: ${plainReason(c, owner)}`));
  }
  if (owner) lines.push("Open a part below for the fix.");
  return lines;
}
