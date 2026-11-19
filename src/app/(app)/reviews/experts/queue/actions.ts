"use server";
// Claims-queue server actions (M13-lite WP6; UXN-295, D-529, D-530). Owner and Editor: requireUser
// ("review_claims") runs first (a refusal is a 403 and is audit-logged by the guard). The ids and the
// text come from the form but are validated by the service; the actor is always the signed-in user, and
// every action writes one audit event before the change (src/lib/experts/review.ts).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { HOME_MARKET } from "@/lib/market/homeMarket.mjs";
import { maskContextFor } from "@/lib/view/mask";
import {
  bulkConfirmExpert,
  confirmCall,
  confirmCluster,
  confirmClaim,
  confirmTypedCall,
  editClaim,
  mergeCluster,
  mergeClaimToCluster,
  parkClaim,
  rejectClaim,
  type ReviewCtx,
  type ReviewResult,
} from "@/lib/experts/review";

const PATH = "/reviews/experts/queue";

export type QueueResult = { ok: true } | { error: string };

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

async function run(
  fn: (ctx: ReviewCtx & { market: string }) => Promise<ReviewResult<object>>,
  opts: { unmaskedOnly?: boolean } = {},
): Promise<QueueResult> {
  const user = await requireUser("review_claims", PATH);
  try {
    // D-633: an edit saves text, and a masked Editor only ever saw masked text ("Stock A"), so the edit
    // is refused here too, not only hidden on the page (UX-004: every control is refused server-side).
    if (opts.unmaskedOnly) {
      const m = await maskContextFor({ id: user.id, role: user.role }, authDb());
      if (m.masked) return { error: "masked" };
    }
    const result = await fn({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      market: HOME_MARKET,
    });
    if ("error" in result) return { error: result.error };
    revalidatePath(PATH);
    revalidatePath("/reviews/experts");
    revalidatePath("/reviews/techniques");
    return { ok: true };
  } catch {
    return { error: "unavailable" };
  }
}

export async function confirmClaimAction(fd: FormData): Promise<QueueResult> {
  return run((c) => confirmClaim(c, field(fd, "claim")));
}

export async function editClaimAction(fd: FormData): Promise<QueueResult> {
  return run(
    (c) =>
      editClaim(c, {
        claimId: field(fd, "claim"),
        statement: field(fd, "statement"),
        formalisationText: field(fd, "formalisation"),
      }),
    { unmaskedOnly: true },
  );
}

export async function rejectClaimAction(fd: FormData): Promise<QueueResult> {
  return run((c) => rejectClaim(c, field(fd, "claim"), field(fd, "reason")));
}

export async function parkClaimAction(fd: FormData): Promise<QueueResult> {
  return run((c) => parkClaim(c, field(fd, "claim"), field(fd, "reason")));
}

export async function mergeClaimAction(fd: FormData): Promise<QueueResult> {
  return run((c) =>
    mergeClaimToCluster(c, {
      claimId: field(fd, "claim"),
      clusterId: field(fd, "cluster"),
      role: field(fd, "role"),
    }),
  );
}

export async function bulkConfirmExpertAction(fd: FormData): Promise<QueueResult> {
  return run((c) => bulkConfirmExpert(c, field(fd, "expert")));
}

export async function confirmClusterAction(fd: FormData): Promise<QueueResult> {
  return run((c) => confirmCluster(c, field(fd, "cluster")));
}

export async function mergeClusterAction(fd: FormData): Promise<QueueResult> {
  return run((c) => mergeCluster(c, { from: field(fd, "cluster"), into: field(fd, "into") }));
}

// M22 E3 (KB-084, D-1435): a call is tracked only after the person confirms it. One click confirms the proposal
// shown; the typed form lets the person write the code, direction, date and horizon. A masked Editor only ever saw
// masked codes, so both are refused for them server-side, as editing is (D-633).
export async function confirmCallAction(fd: FormData): Promise<QueueResult> {
  return run(
    (c) => confirmCall(c, { claimId: field(fd, "claim"), proposalId: field(fd, "proposal") }),
    {
      unmaskedOnly: true,
    },
  );
}

export async function typedCallAction(fd: FormData): Promise<QueueResult> {
  return run(
    (c) =>
      confirmTypedCall(c, {
        claimId: field(fd, "claim"),
        code: field(fd, "code"),
        direction: field(fd, "direction"),
        callD: field(fd, "date"),
        horizon: field(fd, "horizon"),
        priceBasis: field(fd, "basis"),
        target: field(fd, "target"),
        stop: field(fd, "stop"),
      }),
    { unmaskedOnly: true },
  );
}
