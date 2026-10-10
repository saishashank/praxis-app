// GitHub workflow dispatch for the master clock (PLT-071). HIGH-RISK: it starts production
// workflows with a repository-scoped token. Only workflow files in DISPATCHABLE_WORKFLOWS can be
// dispatched; the ref is fixed per environment (production -> release, staging -> main). The
// token is used in one header and never logged, returned or placed in an error detail.
import { DISPATCHABLE_WORKFLOWS } from "./schedule";

export const CODE_REPO = "saishashank/praxis-app";
export const DISPATCH_TIMEOUT_MS = 10_000;
export const GITHUB_API_VERSION = "2022-11-28";

export type DispatchEnv = { PRAXIS_ENV: string; GITHUB_DISPATCH_TOKEN?: string };
export type DispatchResult = { ok: boolean; detail: string };

/** SEC-017 (b): production dispatches `ref: release`; (b-s): staging dispatches `ref: main`. */
export function refFor(envName: string): "release" | "main" | null {
  if (envName === "production") return "release";
  if (envName === "staging") return "main";
  return null;
}

const WORKFLOW_RE = /^[a-z0-9][a-z0-9-]*\.yml$/;

export function isDispatchable(workflow: string): boolean {
  return WORKFLOW_RE.test(workflow) && DISPATCHABLE_WORKFLOWS.includes(workflow);
}

/** Never throws. detail is a short fixed string: "HTTP 204", "HTTP 422", an error NAME, ... */
export async function dispatchWorkflow(
  env: DispatchEnv,
  workflow: string,
  f: typeof fetch,
): Promise<DispatchResult> {
  if (!isDispatchable(workflow)) return { ok: false, detail: "workflow-not-allowed" };
  const ref = refFor(env.PRAXIS_ENV);
  if (ref === null) return { ok: false, detail: "unknown-environment" };
  const token = (env.GITHUB_DISPATCH_TOKEN ?? "").trim();
  if (token === "") return { ok: false, detail: "token-missing" };
  try {
    const res = await f(
      `https://api.github.com/repos/${CODE_REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "praxis-sentinel-clock",
        },
        body: JSON.stringify({ ref }),
        redirect: "manual",
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      },
    );
    return res.status === 204
      ? { ok: true, detail: "HTTP 204" }
      : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error && e.name ? e.name.slice(0, 40) : "Error" };
  }
}
