// GET knowledge documents (M7 T4; KB, D-132 draft; all signed-in roles).
//   ?market=AU&type=&q=&limit=      the latest version of each document, no bodies
//   ?market=AU&path=knowledge/...    one document with its body (&version=N for an older one)
// TODO(M7 T2): pass bodies and lists through the masking module (src/lib/view/mask.ts) for masked
// users once it exists; documents can name codes.
import { withAuth } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { isDocType, listDocuments, readDocument } from "@/lib/learning/readers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };
const bad = (): Response => Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });

export const GET = withAuth("read", async (req) => {
  const p = new URL(req.url).searchParams;
  const market = p.get("market") ?? "AU";
  const type = p.get("type");
  const path = p.get("path");
  const limitText = p.get("limit");
  const versionText = p.get("version");
  const q = p.get("q") ?? undefined;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(market)) return bad();
  if (type !== null && !isDocType(type)) return bad();
  if (limitText !== null && !/^\d{1,4}$/.test(limitText)) return bad();
  if (versionText !== null && !/^\d{1,6}$/.test(versionText)) return bad();
  if (q !== undefined && q.length > 100) return bad(); // threshold-ok: search text length cap
  try {
    const db = mainDb();
    if (path !== null) {
      if (!path.startsWith("knowledge/") || !path.endsWith(".md") || path.includes("..")) {
        return bad();
      }
      const doc = await readDocument(db, {
        market,
        path,
        version: versionText === null ? undefined : Number(versionText),
      });
      if (doc === null) {
        return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
      }
      return Response.json({ document: doc }, { headers: HEADERS });
    }
    const documents = await listDocuments(db, {
      market,
      type: type ?? undefined,
      q,
      limit: limitText === null ? undefined : Number(limitText),
    });
    return Response.json({ documents }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
