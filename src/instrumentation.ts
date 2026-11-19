// Next.js instrumentation hook (UX-122): every unhandled server error is written to app_log with its
// digest, the same id the error page shows. Node runtime only (the database client needs it); Next
// does not call this for redirects, not-found or forbidden. See src/lib/ui/errorLog.ts.
import type { RequestErrorContext, RequestInfo } from "@/lib/ui/errorLog";

// M18 OPS-107 / D-965: the app process of the CI "recorded day" (PRAXIS_ENV=recorded). Nothing here runs in
// any other environment (the first line returns). In recorded mode: (1) the host guard refuses every
// non-loopback host, in fetch and in net connects, and counts the refusals; (2) the guard writes its
// marker so the job can prove this process had it installed; (3) the clock moves to PRAXIS_SIM_NOW, so
// the signed routes run "at" the simulated time of the day.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.PRAXIS_ENV !== "recorded") return;
  const [guard, clock, net] = await Promise.all([
    import("@/lib/data/recorded/hostGuard.mjs"),
    import("@/lib/data/recorded/simClock.mjs"),
    import("node:net"),
  ]);
  guard.installHostGuard(process.env);
  guard.installNetGuard(process.env, net.default);
  guard.writeGuardMarker(process.env, process.env.PRAXIS_NET_LABEL ?? "app");
  const simNow = clock.simNowFromEnv(process.env);
  if (simNow !== null) clock.installSimClock(simNow);
  // The quote source: the chart endpoint is answered in process with synthetic charts (no request is made).
  const [{ QUOTE_CHART_URL }, { recordedQuoteFetch }] = await Promise.all([
    import("@/lib/data/quotes/fetch"),
    import("@/lib/data/quotes/recordedFetch"),
  ]);
  globalThis.fetch = recordedQuoteFetch(globalThis.fetch, QUOTE_CHART_URL);
}

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
