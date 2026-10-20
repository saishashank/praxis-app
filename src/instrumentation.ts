// Next.js instrumentation hook (UX-122): every unhandled server error is written to app_log with its
// digest, the same id the error page shows. Node runtime only (the database client needs it); Next
// does not call this for redirects, not-found or forbidden. See src/lib/ui/errorLog.ts.
import type { RequestErrorContext, RequestInfo } from "@/lib/ui/errorLog";

export async function onRequestError(
  err: unknown,
  request: RequestInfo,
  context: RequestErrorContext,
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ mainDb }, { logRequestError }] = await Promise.all([
      import("@/lib/db/client"),
      import("@/lib/ui/errorLog"),
    ]);
    await logRequestError(mainDb(), err, request, context);
  } catch {
    // database not configured or unreachable: nothing more to do
  }
}
