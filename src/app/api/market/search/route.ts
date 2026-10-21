// GET instant search over the active universe (UXN-270, decision 49, M7 T8, D-136 draft):
// `?q=` 1..40 characters, at most 20 results, all signed-in roles. A masked user gets an empty list and
// a note: matching a typed code against masked rows would reveal which codes exist (DAT-124, D-129).
import { withAuth } from "@/lib/auth/guard";
import { parseSearchQuery, searchInstruments } from "@/lib/ui/loaders/market";
import { envFor } from "@/lib/ui/loaders/shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

export const GET = withAuth("read", async (req, user) => {
  const q = parseSearchQuery(new URL(req.url).searchParams);
  if (q === null) return Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });
  try {
    const out = await searchInstruments(await envFor({ id: user.id, role: user.role }), q);
    return Response.json(out, { headers: HEADERS });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
