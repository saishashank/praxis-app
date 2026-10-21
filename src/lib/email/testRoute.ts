// Owner-only "send test email" action (EML-034, design 4.10, D-096 decision 23): POST
// /api/email/test. The same-origin check (SEC-011) and the session gate run in the proxy; this
// handler is wrapped in withAuth("admin") (Owner only). Audit first, then the limits (at most
// `test_email_daily_max` a day, one per `test_email_min_interval_min` minutes, fixed keys
// test:<d>:<n>), then the normal send path (pool slot; allowed only in `full` mode, design 4.12).
import type { Client } from "@libsql/client";
import { audit, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import type { CurrentUser } from "@/lib/auth/session";
import { formatMelbourne } from "@/lib/health/format";
import { loadCaps, nextTestNumber } from "./caps";
import { emailKeys, melbourneDate } from "./keys";
import { emailEnvName, sendEmail, type SendContext, type SendStatus } from "./send";

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const HTTP: Record<SendStatus, number> = {
  sent: 200,
  pending: 202,
  duplicate: 429,
  suppressed_cap: 409,
  suppressed_off: 409,
  suppressed_paused: 409,
  no_recipient: 409,
  failed: 502,
  invalid: 500,
};

export type TestRouteDeps = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv & SendContext["env"];
  meta: RequestMeta;
  now?: () => Date;
  provider?: SendContext["provider"];
  sleep?: SendContext["sleep"];
};

export async function handleTestEmail(deps: TestRouteDeps, user: CurrentUser): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const d = melbourneDate(now);
  try {
    await audit(deps.authDb, deps.env, deps.meta, {
      at: now.toISOString(),
      actorUserId: user.id,
      action: "email.test_requested",
      targetType: "email",
      targetId: d,
      detail: {},
    });
    const caps = await loadCaps(deps.mainDb);
    const n = await nextTestNumber(deps.mainDb, emailEnvName(deps.env), d, now, caps);
    if (n === null) return json(429, { error: "rate_limited" });
    const out = await sendEmail(
      {
        db: deps.mainDb,
        env: deps.env,
        now: deps.now,
        provider: deps.provider,
        sleep: deps.sleep,
      },
      "test",
      emailKeys.test(d, n),
      { requestedAt: formatMelbourne(now.toISOString()) },
    );
    return json(HTTP[out.status], { status: out.status });
  } catch {
    return json(503, { error: "unavailable" });
  }
}
