// GET the nightly plan and its review (M7 T4; ARN-066, D-132 draft; all signed-in roles).
// `?market=AU&d=YYYY-MM-DD`; without `d` the latest plan. Stored rows only.
// TODO(M7 T2): pass the view through the masking module (src/lib/view/mask.ts) for masked users once
// it exists; the plan text can name a code.
import { withAuth } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { isDate, readPlan } from "@/lib/learning/readers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

export const GET = withAuth("read", async (req) => {
  const url = new URL(req.url);
  const market = url.searchParams.get("market") ?? "AU";
  const d = url.searchParams.get("d") ?? undefined;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(market) || (d !== undefined && !isDate(d))) {
    return Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });
  }
  try {
    return Response.json(await readPlan(mainDb(), market, d), { headers: HEADERS });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
