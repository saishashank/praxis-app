"use server";
// Run a what-if (UX-119, ROL-102a; M7 T19b; docs/M7_design.md decision 54; D-148 draft). Owner and
// Editor. Order of work: the role guard FIRST (a refusal is a 403 and is audit-logged by the guard),
// then validation, the daily limit and a lookup of stored nightly rows in src/lib/whatif/service.ts.
// Nothing is computed or written to trading tables; a successful answer is audited first. Origin and
// rate limits are applied by the proxy gate (SEC-011/014). The result is data or a code only.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import type { WhatIfView } from "@/lib/whatif/options";
import { runWhatIf } from "@/lib/whatif/service";
import type { WhatIfActionResult } from "./messages";

const PATH = "/what-if";

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function runWhatIfAction(fd: FormData): Promise<WhatIfActionResult> {
  const user = await requireUser("what_if", PATH);
  let result;
  try {
    result = await runWhatIf(
      { mainDb: mainDb(), authDb: authDb(), env: process.env, meta: requestMeta(await headers()) },
      user,
      {
        kind: field(fd, "kind"),
        key: field(fd, "key"),
        profile: field(fd, "profile"),
        pct: field(fd, "pct"),
      },
    );
  } catch {
    return { error: "unavailable" };
  }
  if (result.status !== 200) {
    const code = result.body.error;
    return { error: typeof code === "string" ? code : "unavailable" };
  }
  revalidatePath(PATH);
  return {
    ok: true,
    view: result.body.view as WhatIfView,
    budget: result.body.budget as { limit: number; used: number; remaining: number },
  };
}
