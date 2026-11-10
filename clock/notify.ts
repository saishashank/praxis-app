// Failure email of a clock job (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.3). On GitHub the Owner gets
// GitHub's own "run failed" email; on the clock the same alert goes through Resend (the adapter the app
// and the watchdog use), to the Owner address only, with a pointer to `praxis run logs <id>` instead of a
// GitHub run link. No log text, no secret and no URL is put in the mail: ids, job name, status and code.
import {
  guardRecipient,
  ownerAddress,
  type EmailEnvVars,
  type OutgoingEmail,
} from "../src/lib/email/provider";
import { createResendProvider, RESEND_FROM } from "../src/lib/email/resend";

export type FailureInfo = { job: string; runId: number; status: string; exitCode: number | null };

export function failureEmail(env: EmailEnvVars, f: FailureInfo, to: string): OutgoingEmail {
  const label = f.status === "timeout" ? "timed out" : "failed";
  const code = f.exitCode === null ? "no exit code" : `exit code ${f.exitCode}`;
  const text = [
    `Job ${f.job} ${label} on the self-hosted runtime (run ${f.runId}, ${code}).`,
    "",
    `See the log on the server: praxis run logs ${f.runId}`,
    "(the same command works as: praxis logs " + f.runId + ")",
  ].join("\n");
  const html = `<p>Job <b>${f.job}</b> ${label} on the self-hosted runtime (run ${f.runId}, ${code}).</p><p>See the log on the server: <code>praxis run logs ${f.runId}</code></p>`;
  return {
    from: RESEND_FROM,
    to,
    subject: `[Praxis] Job ${f.job} ${label} (run ${f.runId})`,
    html,
    text,
    idempotencyKey: `${env.PRAXIS_ENV ?? "production"}:jobfail:${f.job}:${f.runId}`,
  };
}

/**
 * "sent" | "skipped" (email not configured: provider other than resend, no key, no Owner address) |
 * "failed". Never throws.
 */
export async function sendFailureEmail(
  env: EmailEnvVars,
  info: FailureInfo,
  f: typeof fetch,
): Promise<"sent" | "skipped" | "failed"> {
  try {
    const owner = ownerAddress(env);
    const apiKey = (env.RESEND_API_KEY ?? "").trim();
    if ((env.EMAIL_PROVIDER ?? "").trim().toLowerCase() !== "resend" || !apiKey || !owner) {
      return "skipped";
    }
    const provider = guardRecipient(createResendProvider({ apiKey, fetchImpl: f, env }), owner);
    const res = await provider.send(failureEmail(env, info, owner));
    return res.outcome === "accepted" ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
