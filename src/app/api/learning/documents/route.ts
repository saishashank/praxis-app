// GET knowledge documents (M7 T4; KB, D-132 draft; all signed-in roles).
//   ?market=AU&type=&q=&limit=      the latest version of each document, no bodies
//   ?market=AU&path=knowledge/...    one document with its body (&version=N for an older one)
// Masked users (non-Owner without a live unmask grant) get bodies and lists through the masking module.
import { withAuth } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { LearningMasker } from "@/lib/learning/mask";
import { maskContextFor } from "@/lib/view/mask";
import { isDocType, listDocuments, readDocument } from "@/lib/learning/readers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };
const bad = (): Response => Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });

export const GET = withAuth("read", async (req, user) => {
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
    const ctx = await maskContextFor(user.role ? { id: user.id, role: user.role } : null, authDb());
    const masker = ctx.masked ? new LearningMasker(db, market) : null;
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
      return Response.json(
        { document: masker ? await masker.document(doc) : doc },
        { headers: HEADERS },
      );
    }
    const documents = await listDocuments(db, {
      market,
      type: type ?? undefined,
      q,
      limit: limitText === null ? undefined : Number(limitText),
    });
    return Response.json(
      { documents: masker ? await masker.documents(documents) : documents },
      { headers: HEADERS },
    );
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
