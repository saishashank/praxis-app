// Signed handler of `POST /api/internal/preopen` (M5 T8; D-067 pattern, D-029 wire format, SEC-017 c2).
// Body { purpose: "preopen", env, d, attempt: 1 | 2 }. The verification, date and environment checks
// are the alert routes' (`signed`): secret, headers, +-300 s, constant-time signature, single-use
// nonce, fixed failure words, nothing echoed. A re-check that fails answers 503 so the Worker retries
// at 09:58; a skip (market not full, non-trading day) and a repeat answer 200.
import { signed, type MachineDeps } from "@/lib/alerts/machine";
import { enabledMarkets } from "@/lib/market/profile";
import { PREOPEN_PURPOSE, runPreopen } from "./preopen";

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function createPreopenHandler(deps: MachineDeps) {
  return signed(PREOPEN_PURPOSE, deps, async (body, nowSec) => {
    const a = body.attempt;
    if (a !== undefined && a !== 1 && a !== 2) return json(400, { error: "bad_request" });
    const db = deps.ctx().db;
    // MKT-110 (a): the market is the body's, else the single enabled market; a market that is not enabled is refused
    const enabled = await enabledMarkets(db);
    const asked = typeof body.market === "string" ? body.market : null;
    const market = asked ?? (enabled.length === 1 ? enabled[0]! : null);
    if (market === null || !enabled.includes(market)) return json(400, { error: "bad_request" });
    const r = await runPreopen(db, {
      market,
      d: body.d as string,
      attempt: a === 2 ? 2 : 1,
      strictCalendar: true, // D-711
      now: () => new Date(nowSec * 1000).toISOString(),
    });
    if (r.status === "error") return json(503, { error: "unavailable" });
    if (r.status === "skipped") return json(200, { status: "skipped", reason: r.reason });
    return json(200, {
      status: r.status,
      attempt: r.attempt,
      checked: r.checked,
      cancelled: r.cancelled,
    });
  });
}
