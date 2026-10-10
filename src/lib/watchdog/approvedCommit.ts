// Nightly approved-commit check (SEC-108 d, AT-05b). Opus reviews every line.
//
// Requirements relied on (quoted verbatim from the spec):
// - SEC-108 c: "**Every `production` workflow checks out the commit of the latest approved
//   `deploy-production` deployment** (read via the GitHub API), not the `release` head, so a
//   merged release runs nothing new until the Owner approves it"
// - SEC-108 d: "As defence in depth, a nightly check in the production Vercel app reads GitHub
//   with token (m) and raises an **S1** incident if the deployed Vercel commit (`APP_COMMIT`,
//   passed in by the deploy job [VERIFY whether `VERCEL_GIT_COMMIT_SHA` is set for CLI deploys]),
//   the production Worker's reported build commit, or the commit recorded by any production run
//   differs from the latest **approved** `deploy-production` deployment (runbook OPS-045); until
//   a first approved deployment exists it shows "awaiting first approval". **As a fallback if
//   GitHub is unreachable or token (m) is compromised, a DB-stored signed record of the last
//   approved deployment commit is checked; this secondary record is written by a separate,
//   signed Vercel route at approval time and verified by the nightly check as a hash match
//   **(s11)**."
// - PLT-074: "Heartbeat routes are GET (Vercel Cron) authenticated with `CRON_SECRET`,
//   idempotent, and **no-op outside the production environment** (staging never raises heartbeat
//   incidents)."
// - PLT-011: "Vercel Cron MUST NOT be relied on for any time-sensitive job: on Hobby it runs at
//   most once per day and fires **anywhere within the configured UTC hour** [VERIFY], and faster
//   schedules fail deployment (V). It MAY be used only for a low-priority daily
//   housekeeping/heartbeat."
// - OPS-045: "Unapproved production release (S1). Symptoms: S1 email / watchdog failure / Vercel
//   deployment email you did not expect. Actions: roll back production (OPS-042) to the last
//   approved commit; revoke the build-agent PAT; rotate **all** production secrets ..."
// - AT-05b: "a web-merged approved release (same tree, new commit id) passes the nightly check
//   while an extra unapproved commit fails it (pre-registered test incident, OPS-045 not
//   triggered) ... With the GitHub API unreachable (mocked 503), the nightly deployed-commit
//   check uses the DB-signed record (SEC-108 d) and raises an S1 incident on mismatch."
// - SEC-017 (m): "GitHub read token for release detection | fine-grained, code repo only:
//   contents, actions and deployments: read | ≤ 1 y | production Vercel env only"
//   (env name GITHUB_READ_TOKEN)
// - Ch. 15: "heartbeat_crons | Vercel Cron in the 00:xx and 11:xx UTC hours (fires anywhere in
//   the hour; production only; wording PLT-011) | O | PLT-074" and "watchdog_times | 20:40 and
//   21:50 Melbourne | O | PLT-014a, NFR-006" (the latter is the YAML watchdog, not this route).
// - S1 (ops runbook): "S1 | Ledger invariant violated; data corruption suspected; secret leaked;
//   unauthorised access in audit log | Same day: pause affected market (switch in Settings),
//   follow §11.5"; NFR-006 table: "Unapproved production code (SEC-108 d) | S1 incident
//   email + watchdog deliberate failure ..."
//
// TODO (SEC-108 d last sentence, AT-05b last clause): the DB-signed fallback record of the last
//   approved deployment commit is NOT built yet. Today a GitHub failure yields "unknown", which
//   is never "ok" and never raises an S1 (no false alarms from an outage).
// TODO (AT-05b "same tree, new commit id"): a web-merged approved release has a new commit id
//   with the same tree. This check compares commit ids only, so it would report a mismatch for
//   that case; tree comparison (GitHub commits API) is follow-up work before the first
//   web-merged release. The check stays fail-safe (alerts rather than passes).
// TODO (SEC-108 d): the production Worker's reported build commit and the commit recorded by
//   production runs are not compared yet (the Worker arrives in M2).
import {
  Fail,
  findApprovedSha,
  isValidRepo,
  SHA,
} from "../../../scripts/ci/approved-commit-core.mjs";

import type { WatchdogStatus } from "./state";

export type { WatchdogStatus };

export type WatchdogResult = {
  status: WatchdogStatus;
  approvedSha?: string;
  deployedSha?: string;
  /** Short fixed text. Never contains the token or an upstream response body. */
  detail: string;
};

export type CheckInput = {
  fetchImpl: typeof fetch;
  token: string | undefined;
  repo: string;
  deployedCommit: string | undefined;
};

function normalizeSha(v: string | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return SHA.test(s) ? s : null;
}

export async function checkApprovedCommit(input: CheckInput): Promise<WatchdogResult> {
  const token = (input.token ?? "").trim();
  if (token === "") return { status: "unknown", detail: "GitHub read token is not configured." };
  if (!isValidRepo(input.repo)) return { status: "unknown", detail: "Repository name is invalid." };

  let approved: string | null;
  try {
    approved = await findApprovedSha(
      input.fetchImpl as unknown as Parameters<typeof findApprovedSha>[0],
      token,
      input.repo,
    );
  } catch (e) {
    // Fail messages are fixed text or an HTTP status; anything else is reduced to a constant.
    return { status: "unknown", detail: e instanceof Fail ? e.message : "GitHub request failed." };
  }

  const deployed = normalizeSha(input.deployedCommit);
  if (approved === null) {
    return {
      status: "awaiting_first_approval",
      ...(deployed ? { deployedSha: deployed } : {}),
      detail: "No approved deploy-production deployment yet.",
    };
  }
  if (deployed === null) {
    return {
      status: "unknown",
      approvedSha: approved,
      detail: "The deployed commit (APP_COMMIT) is missing or malformed.",
    };
  }
  if (deployed !== approved) {
    return {
      status: "mismatch",
      approvedSha: approved,
      deployedSha: deployed,
      detail: "Deployed commit differs from the latest approved deployment.",
    };
  }
  return {
    status: "ok",
    approvedSha: approved,
    deployedSha: deployed,
    detail: "Deployed commit is the latest approved deployment.",
  };
}
