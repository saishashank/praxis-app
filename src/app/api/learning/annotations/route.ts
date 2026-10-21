// Annotations (M6 T14, ROL-102b, UX-071a, KB-051): GET all roles (Viewers see masked notes),
// POST/PATCH/DELETE Editor and Owner (edit/delete: the author or the Owner). Audit-logged, with
// history. The spec path is /api/annotations; T14 places it under /api/learning (file scope).
import { withAuth } from "@/lib/auth/guard";
import {
  addAnnotation,
  deleteAnnotation,
  editAnnotation,
  listAnnotations,
  readBody,
  toResponse,
} from "@/lib/learning/ownerActions";
import { badBody, ownerCtx } from "../_ctx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withAuth("read", async (req, user) => {
  const q = new URL(req.url).searchParams;
  return toResponse(
    await listAnnotations(ownerCtx(req), user, {
      subjectKind: q.get("subject_kind"),
      subjectId: q.get("subject_id"),
      history: q.get("history") === "1",
    }),
  );
});

export const POST = withAuth("annotate", async (req, user) => {
  const b = await readBody(req);
  return b === null ? badBody() : toResponse(await addAnnotation(ownerCtx(req), user, b));
});

export const PATCH = withAuth("annotate", async (req, user) => {
  const b = await readBody(req);
  return b === null ? badBody() : toResponse(await editAnnotation(ownerCtx(req), user, b));
});

export const DELETE = withAuth("annotate", async (req, user) => {
  const b = await readBody(req);
  return b === null ? badBody() : toResponse(await deleteAnnotation(ownerCtx(req), user, b));
});
