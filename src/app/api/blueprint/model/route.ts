// GET /api/blueprint/model (M16 WP5, UXN-298). Serves the committed architecture model to the pinned
// Owner only (SEC-111); everyone else gets the app's 404. The file is read at request time on the
// server and is never imported into a client bundle (D-372). Read-only, no-store, noindex (SEC-112).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NOINDEX_HEADERS, requirePinnedOwnerRoute } from "@/lib/auth/blueprintGuard";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  await requirePinnedOwnerRoute("/api/blueprint/model");
  const text = await readFile(
    path.join(process.cwd(), "docs", "architecture", "architecture.json"),
    "utf8",
  );
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NOINDEX_HEADERS },
  });
}
