// M17 WP5: signed handler of `POST /api/internal/intraday-scan` (D-067 pattern: HMAC, +-300 s,
// single-use nonce, fixed failure words). Body { purpose: "intraday-scan", env, d, slot }.
// A skip or a repeat answers 200 with a fixed status word; an unexpected error answers 503.
import type { Client } from "@libsql/client";
import type { AlertCtx } from "@/lib/alerts/deliver";
import { signed, type MachineDeps } from "@/lib/alerts/machine";
import { runIntradayScan, type ScanRunDeps } from "./run";

export const SCAN_PURPOSE = "intraday-scan";

export type ScanHandlerDeps = Omit<MachineDeps, "ctx"> & {
  db: () => Client;
  fetch: ScanRunDeps["fetch"];
  sleep: ScanRunDeps["sleep"];
  mailCandidates?: ScanRunDeps["mailCandidates"];
};

export function createIntradayScanHandler(deps: ScanHandlerDeps) {
  return signed(
    SCAN_PURPOSE,
    { ...deps, ctx: () => ({ db: deps.db(), env: deps.env as AlertCtx["env"] }) },
    async (_b, nowSec) => {
      const r = await runIntradayScan({
        db: deps.db(),
        now: () => new Date(nowSec * 1000),
        fetch: deps.fetch,
        sleep: deps.sleep,
        mailCandidates: deps.mailCandidates,
      });
      const body =
        r.status === "skipped"
          ? { status: r.reason === "already_done" ? "already_done" : "skipped", reason: r.reason }
          : {
              status: "ok",
              slot: r.slot,
              requests: r.requests,
              codes: r.codes,
              quotes: r.quotes,
              written: r.written,
              gate_failed: r.gateFailed,
              narrowed: r.narrowed,
              paused: r.paused,
              volume_unavailable: r.volumeUnavailable,
            };
      return Response.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
    },
  );
}
