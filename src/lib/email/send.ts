// sendEmail: the one door every email goes through (M5 T3, design 2.4, 4.9, 4.10, 4.12; D-096).
//
// Order: key check -> production switch (`email_mode`) -> pause -> recipient and provider ->
// atomic claim with caps (one email per key) -> render -> provider call with an Idempotency-Key ->
// attempt log -> one-way move of the row (claimed -> sent | failed). Attempts: up to two per
// invocation (the second after 2 s, or Retry-After when it is <= 5 s), the third by a later
// invocation after >= 60 s with the same key; a `claimed` row older than 3 min (60 s once it has an
// attempt) may be taken over by compare-and-swap, so a crash after acceptance cannot send twice
// inside the provider's idempotency window. Rejections fail at once; 401/403 are flagged
// (`authFailure`) so the caller can open the provider incident (NFR-006).
//
// Privacy (EML-005): the address is never written anywhere (recipient_sha is a keyed hash), message
// bodies are not logged, nothing here logs at all: the record is email_message / email_attempt.
// Sends are serialised per process (design 4.10).
import { createHmac } from "node:crypto";
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { EmailEnv, EmailKind, EmailSlot } from "@/lib/sentinel/schema";
import { claimKey, loadCaps, recordRow } from "./caps";
import { dateInKey, keyMatchesKind, melbourneDate, suppressedKey } from "./keys";
import {
  guardRecipient,
  isTestRuntime,
  LiveSendBlockedError,
  ownerAddress,
  RecipientGuardError,
} from "./provider";
import type { EmailEnvVars, EmailProvider, OutgoingEmail, ProviderResult } from "./provider";
import { RESEND_FROM } from "./resend";
import { selectProvider } from "./select";
import { emailKindAllowed, readEmailSwitch } from "./switch";
import { renderP0, renderP0Batch } from "./templates/alerts";
import type { P0BatchInput, P0Input } from "./templates/alerts";
import type { EnvName, SizedEmailOut } from "./templates/core";
import { renderIncident, renderTest, renderTokensDue, renderUnread7 } from "./templates/notices";
import type { IncidentInput, TokensDueInput, UnreadInput } from "./templates/notices";
import { renderBrief, renderReminder } from "./templates/reminder";
import type { BriefInput, ReminderInput } from "./templates/reminder";
import { renderReview } from "./templates/review";
import type { ReviewFacts } from "./templates/review";

type Facts<T> = Omit<T, "env" | "appUrl">;
type IncidentFacts = Omit<IncidentInput, "env" | "appUrl" | "event">;

/** Typed facts per kind; the sender adds `env` and `appUrl`. */
export interface FactsByKind {
  review: Facts<ReviewFacts>;
  p0: Facts<P0Input>;
  p0_batch: Facts<P0BatchInput>;
  incident_open: IncidentFacts;
  incident_s1: IncidentFacts;
  /** "Database unreachable" (NFR-006 l.15) uses the incident layout. */
  dbdown: IncidentFacts;
  tokens: Facts<TokensDueInput>;
  unread7: Facts<UnreadInput>;
  reminder: Facts<ReminderInput>;
  brief: Facts<BriefInput>;
  test: { requestedAt: string };
}

export interface SendContext {
  db: Pick<Client, "execute">;
  env: EmailEnvVars;
  now?: () => Date;
  /** Defaults to selectProvider(env): mock in every test run. */
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
}

export type SendStatus =
  | "sent"
  | "duplicate"
  | "suppressed_off"
  | "suppressed_paused"
  | "suppressed_cap"
  | "no_recipient"
  | "failed"
  | "pending"
  | "invalid";

export interface SendOutcome {
  status: SendStatus;
  /** Provider calls made so far for this key (all invocations). */
  attempts: number;
  slot?: EmailSlot;
  providerId?: string;
  /** 401/403 from the provider: the caller opens the provider incident (NFR-006). */
  authFailure?: boolean;
  reason?: string;
}

export interface SendOptions {
  /** The Evening Review sent by the watchdog's direct path (allowed in `incidents` mode). */
  watchdogFallback?: boolean;
}

export const CLAIM_STALE_S = 180; // design 2.4 (as the Worker clock)
export const RETRY_GAP_S = 60; // design 4.10: the third attempt waits >= 60 s
export const IN_REQUEST_DELAY_S = 2;
export const RETRY_AFTER_MAX_S = 5;
export const MAX_ATTEMPTS = 3;

const ENV_NAMES: readonly EmailEnv[] = ["production", "staging", "development", "test"];

/** Which environment's counters and prefix apply. */
export function emailEnvName(env: EmailEnvVars): EmailEnv {
  const v = env.PRAXIS_ENV;
  if (v && (ENV_NAMES as readonly string[]).includes(v)) return v as EmailEnv;
  if (env.VERCEL_ENV === "production") return "production";
  return isTestRuntime(env) ? "test" : "development";
}

const templateEnv = (e: EmailEnv): EnvName => (e === "staging" ? "staging" : "production");

let chain: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function render<K extends EmailKind>(
  kind: K,
  facts: FactsByKind[K],
  env: EnvName,
  appUrl: string,
): SizedEmailOut {
  const f = facts as unknown;
  const base = { env, appUrl };
  switch (kind) {
    case "review":
      return renderReview({ ...(f as FactsByKind["review"]), ...base });
    case "p0":
      return renderP0({ ...(f as FactsByKind["p0"]), ...base });
    case "p0_batch":
      return renderP0Batch({ ...(f as FactsByKind["p0_batch"]), ...base });
    case "incident_open":
      return renderIncident({ ...(f as IncidentFacts), ...base, event: "open" });
    case "incident_s1":
      return renderIncident({
        ...(f as IncidentFacts),
        ...base,
        event: "escalated",
        severity: "S1",
      });
    case "dbdown":
      return renderIncident({ ...(f as IncidentFacts), ...base, event: "open", severity: "S1" });
    case "tokens":
      return renderTokensDue({ ...(f as FactsByKind["tokens"]), ...base });
    case "unread7":
      return renderUnread7({ ...(f as FactsByKind["unread7"]), ...base });
    case "reminder":
      return renderReminder({ ...(f as FactsByKind["reminder"]), ...base });
    case "brief":
      return renderBrief({ ...(f as FactsByKind["brief"]), ...base });
    case "test":
      return renderTest({ ...(f as FactsByKind["test"]), ...base });
    default:
      throw new Error("unknown email kind");
  }
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

async function readRow(
  db: Pick<Client, "execute">,
  key: string,
): Promise<{ status: string; attempts: number; claimAt: string; claimN: number } | null> {
  const r = await db.execute({
    sql: `SELECT status, attempts, created_at,
                 json_extract(ref_json, '$.claim_at') AS claim_at,
                 COALESCE(json_extract(ref_json, '$.claim_n'), 0) AS claim_n
          FROM email_message WHERE email_key = ?`,
    args: [key],
  });
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return {
    status: String(x.status),
    attempts: Number(x.attempts),
    claimAt: typeof x.claim_at === "string" ? x.claim_at : String(x.created_at),
    claimN: Number(x.claim_n),
  };
}

/** Takes over a stale `claimed` row (compare-and-swap on the claim counter). */
async function reclaim(
  db: Pick<Client, "execute">,
  key: string,
  row: { status: string; attempts: number; claimAt: string; claimN: number },
  now: Date,
): Promise<boolean> {
  if (row.status !== "claimed" || row.attempts >= MAX_ATTEMPTS) return false;
  const needS = row.attempts > 0 ? RETRY_GAP_S : CLAIM_STALE_S;
  if (now.getTime() - new Date(row.claimAt).getTime() < needS * 1000) return false;
  const r = await db.execute({
    sql: `UPDATE email_message
          SET ref_json = json_set(ref_json, '$.claim_at', ?, '$.claim_n', ?)
          WHERE email_key = ? AND status = 'claimed' AND attempts = ?
            AND COALESCE(json_extract(ref_json, '$.claim_n'), 0) = ?`,
    args: [now.toISOString(), row.claimN + 1, key, row.attempts, row.claimN],
  });
  return r.rowsAffected === 1;
}

async function suppress(
  ctx: SendContext,
  p: {
    key: string;
    kind: EmailKind;
    envName: EmailEnv;
    d: string;
    nowIso: string;
    status: "suppressed_off" | "suppressed_paused" | "no_recipient";
    why: "off" | "paused" | "no_recipient";
    reason?: string;
  },
): Promise<SendOutcome> {
  // The record uses its own key so a later change of the switch can still send the real key.
  try {
    await recordRow(ctx.db, {
      key: suppressedKey(p.key, p.why),
      kind: p.kind,
      env: p.envName,
      d: p.d,
      slot: kindSlot(p.kind),
      status: p.status,
      nowIso: p.nowIso,
      ref: { for: p.key },
    });
  } catch {
    // the record is best effort; the answer is what matters
  }
  return { status: p.status, attempts: 0, reason: p.reason };
}

function kindSlot(kind: EmailKind): EmailSlot {
  switch (kind) {
    case "review":
      return "reserved_review";
    case "reminder":
      return "reserved_reminder";
    case "incident_open":
    case "incident_s1":
      return "reserved_incident";
    case "p0":
    case "p0_batch":
      return "p0";
    default:
      return "pool";
  }
}

export function sendEmail<K extends EmailKind>(
  ctx: SendContext,
  kind: K,
  key: string,
  facts: FactsByKind[K],
  opts: SendOptions = {},
): Promise<SendOutcome> {
  return serialise(() => sendOne(ctx, kind, key, facts, opts));
}

async function sendOne<K extends EmailKind>(
  ctx: SendContext,
  kind: K,
  key: string,
  facts: FactsByKind[K],
  opts: SendOptions,
): Promise<SendOutcome> {
  const { db, env } = ctx;
  const now = (ctx.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  if (!keyMatchesKind(kind, key)) return { status: "invalid", attempts: 0, reason: "key" };
  const today = melbourneDate(now);
  const d = dateInKey(key) ?? today;
  const envName = emailEnvName(env);
  const base = { key, kind, envName, d, nowIso };

  // 1. The production switch. An unreadable switch is `off` (fail closed).
  let allowed = false;
  try {
    const sw = await readEmailSwitch(db, today);
    allowed = emailKindAllowed(sw, kind, { d, watchdogFallback: opts.watchdogFallback });
  } catch {
    allowed = false;
  }
  if (!allowed) {
    return suppress(ctx, { ...base, status: "suppressed_off", why: "off", reason: "email_mode" });
  }

  // 2. The pause (Evening Review only).
  if (kind === "review") {
    let paused = false;
    try {
      paused = (await getConfig(db as Client, "evening_review_paused")) === "on";
    } catch {
      paused = false;
    }
    if (paused) {
      return suppress(ctx, { ...base, status: "suppressed_paused", why: "paused" });
    }
  }

  // 3. Recipient, link base and provider. Missing recipient = EML-006 (never a failure).
  const owner = ownerAddress(env);
  if (!owner) return suppress(ctx, { ...base, status: "no_recipient", why: "no_recipient" });
  const appUrl = (env.APP_BASE_URL ?? "").trim();
  const inner = ctx.provider ?? selectProvider(env);
  if (inner.name === "null" || !/^https?:\/\//.test(appUrl)) {
    return suppress(ctx, {
      ...base,
      status: "suppressed_off",
      why: "off",
      reason: inner.name === "null" ? "provider_null" : "no_app_url",
    });
  }
  const provider = guardRecipient(inner, owner);

  // 4. Claim with caps: one email per key.
  const piiKey = env.PII_HASH_KEY;
  const recipientSha = piiKey ? createHmac("sha256", piiKey).update(owner).digest("hex") : null;
  const caps = await loadCaps(db);
  const claim = await claimKey(db, { key, kind, env: envName, d, nowIso, recipientSha, caps });
  let startAttempts = 0;
  let slot: EmailSlot | undefined;
  if (claim.kind === "capped") {
    await recordRow(db, { ...base, env: envName, slot: claim.slot, status: "suppressed_cap" });
    return { status: "suppressed_cap", attempts: 0, slot: claim.slot };
  }
  if (claim.kind === "exists") {
    const row = await readRow(db, key);
    if (!row || !(await reclaim(db, key, row, now))) {
      return { status: "duplicate", attempts: row?.attempts ?? 0, reason: row?.status };
    }
    startAttempts = row.attempts;
  } else {
    slot = claim.slot;
  }

  // 5. Render (after the claim, design 2.4).
  let out: SizedEmailOut;
  try {
    out = render(kind, facts, templateEnv(envName), appUrl);
  } catch {
    await finish(db, key, "failed", startAttempts);
    return { status: "failed", attempts: startAttempts, slot, reason: "render" };
  }
  const subject =
    envName === "staging" && !out.subject.startsWith("[STAGING] ")
      ? `[STAGING] ${out.subject}`
      : out.subject;
  await db.execute({
    sql: "UPDATE email_message SET subject = ?, size_html = ?, size_text = ? WHERE email_key = ? AND status = 'claimed'",
    args: [subject, bytes(out.html), bytes(out.text), key],
  });

  // 6. Attempts.
  const msg: OutgoingEmail = {
    from: RESEND_FROM,
    to: owner,
    subject,
    html: out.html,
    text: out.text,
    idempotencyKey: `${envName}:${key}`,
  };
  const sleep = ctx.sleep ?? defaultSleep;
  let n = startAttempts;
  let inInvocation = 0;
  for (;;) {
    n += 1;
    inInvocation += 1;
    let res: ProviderResult;
    try {
      res = await provider.send(msg);
    } catch (e) {
      if (e instanceof RecipientGuardError) await finish(db, key, "failed", n - 1);
      if (e instanceof LiveSendBlockedError || e instanceof RecipientGuardError) throw e;
      res = { outcome: "network" };
    }
    await logAttempt(db, key, n, nowFor(ctx), res);
    if (res.outcome === "accepted") {
      await db.execute({
        sql: `UPDATE email_message SET status = 'sent', provider_id = ?, sent_at = ?, attempts = ?
              WHERE email_key = ? AND status = 'claimed'`,
        args: [res.providerId ?? null, nowFor(ctx), n, key],
      });
      return { status: "sent", attempts: n, slot, providerId: res.providerId };
    }
    if (res.outcome === "rejected") {
      await finish(db, key, "failed", n);
      return {
        status: "failed",
        attempts: n,
        slot,
        authFailure: res.httpStatus === 401 || res.httpStatus === 403,
        reason: "rejected",
      };
    }
    // retryable | network | timeout
    if (n >= MAX_ATTEMPTS) {
      await finish(db, key, "failed", n);
      return { status: "failed", attempts: n, slot, reason: "retries_exhausted" };
    }
    const ra = res.retryAfterS;
    if (inInvocation >= 2 || (ra !== undefined && ra > RETRY_AFTER_MAX_S)) {
      await db.execute({
        sql: `UPDATE email_message SET attempts = ?, ref_json = json_set(ref_json, '$.claim_at', ?)
              WHERE email_key = ? AND status = 'claimed'`,
        args: [n, nowFor(ctx), key],
      });
      return { status: "pending", attempts: n, slot, reason: "retry_later" };
    }
    await db.execute({
      sql: "UPDATE email_message SET attempts = ? WHERE email_key = ? AND status = 'claimed'",
      args: [n, key],
    });
    await sleep((ra ?? IN_REQUEST_DELAY_S) * 1000);
  }
}

const nowFor = (ctx: SendContext) => (ctx.now ?? (() => new Date()))().toISOString();

async function finish(
  db: Pick<Client, "execute">,
  key: string,
  status: "failed",
  attempts: number,
): Promise<void> {
  await db.execute({
    sql: "UPDATE email_message SET status = ?, attempts = ? WHERE email_key = ? AND status = 'claimed'",
    args: [status, attempts, key],
  });
}

async function logAttempt(
  db: Pick<Client, "execute">,
  key: string,
  n: number,
  at: string,
  res: ProviderResult,
): Promise<void> {
  const accepted = res.outcome === "accepted";
  const status =
    res.httpStatus !== undefined && res.httpStatus >= 100 && res.httpStatus <= 599
      ? res.httpStatus
      : null;
  await db.execute({
    sql: `INSERT INTO email_attempt (email_key, n, at, outcome, http_status, provider_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [key, n, at, res.outcome, status, accepted ? (res.providerId ?? null) : null],
  });
}
