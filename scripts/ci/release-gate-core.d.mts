export type GateMode = "full" | "infrastructure";
export type Conclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "neutral"
  | "action_required"
  | "stale"
  | null;

export interface StepFact {
  name: string;
  conclusion: Conclusion;
}
export interface JobFact {
  name: string;
  conclusion: Conclusion;
  steps?: StepFact[];
}
export interface RunFact {
  /** 40-hex commit the run was started on */
  headSha: string;
  /** ISO timestamp the run was created */
  createdAt: string;
  conclusion: Conclusion;
  jobs: JobFact[];
}

export interface GateInput {
  /** No default: the caller states the mode (decision 25). */
  mode: GateMode;
  /** ISO timestamp of "now". */
  now: string;
  /** 40-hex commit under test. */
  sha: string;
  /** ISO commit date of `sha` (informational; no condition reads it since D-964). */
  commitDate?: string | null;
  /** True once a go_live_signoff row exists: the infrastructure gate is then refused. */
  signoffExists?: boolean;
  /** ISO date; when set, only restore drills created on or after it count (real-key mode). */
  realKeySince?: string | null;
  /** Jobs of the CI run on the commit; null/empty = no run found. */
  ci: JobFact[] | null;
  /** Override of CI_REQUIRED_JOBS (the final list once CI wiring T17 lands). */
  ciRequiredJobs?: string[];
  /** licence-check --release result: failures includes pending entries. */
  licence: { failures: number; pending: number } | null;
  /** Number of findings from the quarantine check, null = not checked. */
  quarantineFindings: number | null;
  /** Number of problems in scripts/ci/audit-exceptions.json, null = not checked. */
  auditExceptionProblems: number | null;
  /** Number of problems in scripts/ci/zap-exceptions.json, null = not checked. */
  zapExceptionProblems: number | null;
  /** Completed push CI runs of the head branch (jobs not needed); null = could not be read (D-964). */
  ciStreak?: RunFact[] | null;
  /** zap-baseline.yml runs on the commit (jobs read); the `local` job must be green and authenticated. */
  zapLocal?: RunFact[];
  restoreDrill?: RunFact[];
  /** D-860 (dormant since D-964: nothing is waivable): parsed entries of docs/release/waivers.json (validated inside the core). */
  waivers?: unknown;
  /** YYYY-MM-DD used to judge waiver expiry; defaults to the date of `now`. */
  today?: string;
}

export interface Waiver {
  condition: string;
  reason: string;
  decidedBy: "Owner";
  decidedOn: string;
  expires: string;
  followUp: string;
}
export interface WaivedCondition {
  id: string;
  label: string;
  decidedOn: string;
  expires: string;
  reason: string;
  followUp: string;
  wouldHaveFailedBecause: string;
}

export interface Condition {
  id: string;
  label: string;
  /** false only for conditions the infrastructure gate does not require */
  required: boolean;
  status: "pass" | "fail" | "not-required" | "waived";
  /** One plain sentence. Never holds a token, URL or SHA. */
  reason: string;
}
export interface GateResult {
  mode: GateMode | "invalid";
  pass: boolean;
  conditions: Condition[];
  /** Conditions that failed but are waived by a valid Owner waiver (never counted as pass). */
  waived?: WaivedCondition[];
  /** Number of waiver entries ignored (expired, invalid or not allow-listed). */
  ignoredWaivers?: number;
}

export const WAIVABLE: string[];
export const MAX_WAIVER_DAYS: number;
export function validateWaivers(
  raw: unknown,
  today: string,
  allow?: readonly string[],
): { valid: Waiver[]; ignored: number };
export const MODES: readonly ["full", "infrastructure"];
export const STREAK_GREENS: number;
export const DRILL_MAX_DAYS: number;
export const CI_REQUIRED_JOBS: string[];
export const STEP: {
  recordedDeadlines: string;
  recordedNetwork: string;
  zapScan: string;
  fixturesStrict: string;
  drill: string;
};
export const JOB: { recordedDay: string; zap: string };
export function evaluateReleaseGate(input: GateInput): GateResult;
export function renderGate(result: GateResult): string;
