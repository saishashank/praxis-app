// Tax report CSV (M21 B3; ARN-122, D-1222, D-1223, D-1265). Owner only: withAuth("admin") answers 401 / 403 JSON, then the
// pinned-Owner rule is checked again. `?market=&fy=&source=book|log`; the log variant needs the Owner tools switch on and
// otherwise answers as a missing route. The file starts with the fixed words and every cell is formula-guarded (csv.ts).
// Same-origin GET, no secrets, nothing written.
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { isPinnedOwner } from "@/lib/auth/blueprintGuard";
import { mainDb } from "@/lib/db/client";
import { enabledMarkets } from "@/lib/market/profile";
import { financialYearOf } from "@/lib/market/seed/taxYear.mjs";
import { logVariantAllowed, parseTaxQuery } from "@/lib/tax/access";
import { reportCsv } from "@/lib/tax/csv";
import { taxReport } from "@/lib/tax/report";
import { melbourneDate } from "@/lib/view/active";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export const GET = withAuth("admin", async (req, user) => {
  if (!isPinnedOwner(user, process.env)) return json(403, "forbidden");
  const params = new URL(req.url).searchParams;
  const db = mainDb();
  const enabled = await enabledMarkets(db);
  const wanted = params.get("market");
  const market =
    wanted === null
      ? enabled.length === 1
        ? enabled[0]!
        : null
      : enabled.includes(wanted)
        ? wanted
        : null;
  if (market === null) return json(400, "bad market");
  const q = parseTaxQuery((k) => params.get(k));
  if (q.source === "log" && !(await logVariantAllowed(user))) return json(404, "not found");
  const today = melbourneDate(new Date().toISOString()) ?? "";
  const fy = q.fy ?? financialYearOf(market, today);
  const report = await taxReport(db, { market, fy, source: q.source });
  const name = q.source === "log" ? "trade-log" : "paper";
  return new Response(reportCsv(report), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="praxis-${name}-gains-${market}-${fy}.csv"`,
    },
  });
});
