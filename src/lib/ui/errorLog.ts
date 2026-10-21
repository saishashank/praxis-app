// Server error log (UX-122, PLT-040): one app_log row per unhandled request error, so the Owner can
// match the correlation id shown on the error page (Next's digest) to a log entry. The row carries the
// digest, the error class, the route TEMPLATE (e.g. /market/[code], never the real path, which may hold
// a code) and the method. It never carries the error message or stack (they can hold data), and the
// function never throws: logging must not turn one error into two.
import type { Client } from "@libsql/client";

export type RequestInfo = { path?: string; method?: string };
export type RequestErrorContext = {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
};

export const ERROR_SOURCE = "web";
const MAX_MESSAGE = 500; // threshold-ok: app_log message length used across the code base

const clean = (v: unknown, re: RegExp, max: number): string => {
  const s = typeof v === "string" ? v : "";
  return s.length > 0 && s.length <= max && re.test(s) ? s : "unknown";
};

export function requestErrorMessage(
  err: unknown,
  request: RequestInfo,
  context: RequestErrorContext,
): string {
  const digest = clean((err as { digest?: unknown } | null)?.digest, /^[\w-]+$/, 40); // threshold-ok
  const name = clean((err as { name?: unknown } | null)?.name, /^[\w$]+$/, 60); // threshold-ok
  const route = clean(context.routePath, /^[\w/[\]().@-]+$/, 120); // threshold-ok
  const method = clean(request.method, /^[A-Z]{3,7}$/, 7); // threshold-ok
  const type = clean(context.routeType, /^[\w-]+$/, 20); // threshold-ok
  return `request_error digest=${digest} class=${name} route=${route} method=${method} type=${type}`.slice(
    0,
    MAX_MESSAGE,
  );
}

export async function logRequestError(
  db: Pick<Client, "execute">,
  err: unknown,
  request: RequestInfo,
  context: RequestErrorContext,
  now: Date = new Date(),
): Promise<void> {
  try {
    await db.execute({
      sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'error', ?, ?, NULL)",
      args: [now.toISOString(), ERROR_SOURCE, requestErrorMessage(err, request, context)],
    });
  } catch {
    // never throw from the error hook
  }
}
