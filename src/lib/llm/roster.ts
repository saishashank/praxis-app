// LLM roster (LLM-070, D-207 item 11): the dated list of free-tier models the router may use.
// A model id that is not in this list, or is `retired`, must not be reachable from any route.
// Roles here are CANDIDATES only: every role stays rules-only until a bake-off passes (D-177).
// No keys or secrets (public repo). Limits are as published on the source page on `checkedOn`;
// null = the page does not state the figure for the free plan (read it in the provider dashboard).

export type RosterStatus = "verified" | "unverified" | "retired";
export type RosterProvider = "google" | "groq" | "openrouter" | "github-models";

export type RosterEntry = {
  provider: RosterProvider;
  modelId: string;
  roles: readonly string[];
  limits: { rpm: number | null; rpd: number | null; tpm: number | null };
  trainsOnPrompts: boolean | null;
  checkedOn: string;
  status: RosterStatus;
  sourceUrl: string;
  note: string;
};

const GOOGLE = "https://ai.google.dev/gemini-api/docs/rate-limits";
const GROQ = "https://console.groq.com/docs/rate-limits";
const OPENROUTER = "https://openrouter.ai/docs/api-reference/limits";
const NO_LIMITS = { rpm: null, rpd: null, tpm: null } as const;
const CHECKED = "2026-10-29";

export const ROSTER: readonly RosterEntry[] = [
  {
    provider: "google",
    modelId: "gemini-2.5-pro",
    roles: ["R3"],
    limits: NO_LIMITS,
    trainsOnPrompts: true,
    checkedOn: CHECKED,
    status: "unverified",
    sourceUrl: GOOGLE,
    note: "R3 candidate; free daily quota is shown only in AI Studio (VERIFY there). Facts only (LLM-036).",
  },
  {
    provider: "google",
    modelId: "gemini-2.5-flash",
    roles: ["R2"],
    limits: NO_LIMITS,
    trainsOnPrompts: true,
    checkedOn: CHECKED,
    status: "unverified",
    sourceUrl: GOOGLE,
    note: "Rate-limits page gives no free-tier figures; see AI Studio.",
  },
  {
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    roles: ["R1"],
    limits: NO_LIMITS,
    trainsOnPrompts: true,
    checkedOn: CHECKED,
    status: "unverified",
    sourceUrl: GOOGLE,
    note: "Bake-off candidate D-177 (failed on call errors, no pass). Exact id not re-confirmed.",
  },
  {
    provider: "google",
    modelId: "gemini-3.8-flash",
    roles: ["R2"],
    limits: NO_LIMITS,
    trainsOnPrompts: true,
    checkedOn: CHECKED,
    status: "unverified",
    sourceUrl: GOOGLE,
    note: "Bake-off candidate D-177 (no pass). Exact id not re-confirmed.",
  },
  {
    provider: "groq",
    modelId: "openai/gpt-oss-120b",
    roles: ["R2", "R3"],
    limits: { rpm: 30, rpd: 1000, tpm: 8000 }, // threshold-ok: documented provider limit (LLM-070)
    trainsOnPrompts: false,
    checkedOn: CHECKED,
    status: "verified",
    sourceUrl: GROQ,
    note: "Figures are the base Developer-plan table (free-plan column not rendered); TPD 200K. Bake-off D-182 pending.",
  },
  {
    provider: "groq",
    modelId: "openai/gpt-oss-20b",
    roles: ["R1", "R2"],
    limits: { rpm: 30, rpd: 1000, tpm: 8000 }, // threshold-ok: documented provider limit (LLM-070)
    trainsOnPrompts: false,
    checkedOn: CHECKED,
    status: "verified",
    sourceUrl: GROQ,
    note: "Same base table as gpt-oss-120b; TPD 200K.",
  },
  {
    provider: "groq",
    modelId: "qwen/qwen3.8-27b",
    roles: ["R2"],
    limits: { rpm: 30, rpd: 1000, tpm: 8000 }, // threshold-ok: documented provider limit (LLM-070)
    trainsOnPrompts: false,
    checkedOn: CHECKED,
    status: "verified",
    sourceUrl: GROQ,
    note: "Same base table; TPD 200K. Next bake-off candidate (D-182).",
  },
  {
    provider: "groq",
    modelId: "llama-3.1-8b-instant",
    roles: ["R1"],
    limits: NO_LIMITS,
    trainsOnPrompts: false,
    checkedOn: CHECKED,
    status: "unverified",
    sourceUrl: GROQ,
    note: "Not in the rate-limits table read on this date; returned errors on all items in D-180.",
  },
  {
    provider: "openrouter",
    modelId: "qwen/qwen3.8-27b:free",
    roles: ["R2"],
    limits: { rpm: 20, rpd: 50, tpm: null }, // threshold-ok: documented provider limit (LLM-070)
    trainsOnPrompts: null,
    checkedOn: CHECKED,
    status: "unverified",
    sourceUrl: OPENROUTER,
    note: "Fallback only, never primary. Limits are the account-wide :free limits (50/day under 10 credits, 1000/day at 10+). Per-model trains_on_prompts not re-read.",
  },
  // Retired: must never be reachable.
  {
    provider: "google",
    modelId: "gemini-2.0-flash",
    roles: [],
    limits: NO_LIMITS,
    trainsOnPrompts: null,
    checkedOn: CHECKED,
    status: "retired",
    sourceUrl: GOOGLE,
    note: "Shut down 2026-06-01 (spec 03 / LLM-070).",
  },
  {
    provider: "google",
    modelId: "gemini-2.0-flash-lite",
    roles: [],
    limits: NO_LIMITS,
    trainsOnPrompts: null,
    checkedOn: CHECKED,
    status: "retired",
    sourceUrl: GOOGLE,
    note: "Shut down 2026-06-01 (spec 03 / LLM-070).",
  },
  {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    roles: [],
    limits: NO_LIMITS,
    trainsOnPrompts: null,
    checkedOn: CHECKED,
    status: "retired",
    sourceUrl: "https://console.groq.com/docs/deprecations",
    note: "Shut down 2026-08-16 (D-182).",
  },
  {
    provider: "github-models",
    modelId: "*",
    roles: [],
    limits: NO_LIMITS,
    trainsOnPrompts: null,
    checkedOn: CHECKED,
    status: "retired",
    sourceUrl: "https://docs.github.com/en/github-models",
    note: "GitHub Models retired 2026-07-30 (spec 03 / LLM-070); no adapter exists.",
  },
];

/** Is this provider/model usable on a route? Unknown ids and retired ids are not. */
export function isRoutable(provider: string, modelId: string): boolean {
  if (ROSTER.some((e) => e.provider === provider && e.status === "retired" && e.modelId === "*"))
    return false;
  const hit = ROSTER.find((e) => e.provider === provider && e.modelId === modelId);
  return hit !== undefined && hit.status !== "retired";
}

/** True when the id is listed as retired (provider-wide for a "*" entry). Used to refuse bake-off candidates. */
export function isRetired(provider: string, modelId: string): boolean {
  return ROSTER.some(
    (e) =>
      e.provider === provider &&
      e.status === "retired" &&
      (e.modelId === "*" || e.modelId === modelId),
  );
}
