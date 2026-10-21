// GET the nightly plan and its review (M7 T4; ARN-066, D-132 draft; all signed-in roles).
// `?market=AU&d=YYYY-MM-DD`; without `d` the latest plan. Stored rows only.
// Masked users (non-Owner without a live unmask grant) get the plan through the masking module.
import { withAuth } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { LearningMasker } from "@/lib/learning/mask";
import { isDate, readPlan } from "@/lib/learning/readers";
import { maskContextFor } from "@/lib/view/mask";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

export const GET = withAuth("read", async (req, user) => {
  const url = new URL(req.url);
  const market = url.searchParams.get("market") ?? "AU";
  const d = url.searchParams.get("d") ?? undefined;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(market) || (d !== undefined && !isDate(d))) {
    return Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });
  }
  try {
    const plan = await readPlan(mainDb(), market, d);
    const ctx = await maskContextFor(user.role ? { id: user.id, role: user.role } : null, authDb());
    const body = ctx.masked ? await new LearningMasker(mainDb(), market).plan(plan) : plan;
    return Response.json(body, { headers: HEADERS });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
