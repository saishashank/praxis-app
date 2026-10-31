// Blueprint export download (M16 WP6; UXN-299, SEC-111, D-368, D-370). Pinned Owner only: the guard
// runs first, so every other caller gets the app's 404 whatever the query says; only then are the
// view and format checked (400). Audited as "blueprint.export" (route only, no query string).
// Local: nothing is fetched or sent anywhere. Same-origin GET.
import { NextResponse } from "next/server";
import model from "../../../../../docs/architecture/architecture.json";
import { NOINDEX_HEADERS, requirePinnedOwnerRoute } from "@/lib/auth/blueprintGuard";
import { toDrawio, toSvg, type ExportModel } from "@/lib/blueprint/export";

export const dynamic = "force-dynamic";

const M = model as unknown as ExportModel;
const VIEWS = M.views.map((v) => v.id);

export async function GET(request: Request): Promise<Response> {
  await requirePinnedOwnerRoute("/api/blueprint/export", "blueprint.export");
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "";
  const format = params.get("format") ?? "";
  if (!VIEWS.includes(view) || (format !== "drawio" && format !== "svg")) {
    return NextResponse.json(
      { error: "bad view or format" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }
  const drawio = format === "drawio";
  return new Response(drawio ? toDrawio(M, view) : toSvg(M, view), {
    status: 200,
    headers: {
      ...NOINDEX_HEADERS,
      "Content-Type": drawio ? "application/xml; charset=utf-8" : "image/svg+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="blueprint-${view}.${drawio ? "drawio" : "svg"}"`,
    },
  });
}
