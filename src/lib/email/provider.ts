// Email provider interface, errors and the recipient guard (M5 T3, docs/M5_design.md 4.9, D-096
// decisions 22 and 44, EML-001/003, SEC-101). Providers: `resend` (resend.ts), `mock` (mock.ts) and
// `null` (never sends); select.ts chooses one. Tests never reach the real network: see
// LiveSendBlockedError and the fetch stub in vitest.setup.ts.

export type ProviderOutcome = "accepted" | "retryable" | "rejected" | "network" | "timeout";

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Sent as the Idempotency-Key header (design 2.4: "<env>:<email key>"). */
  idempotencyKey: string;
}

export interface ProviderResult {
  outcome: ProviderOutcome;
  providerId?: string;
  httpStatus?: number;
  /** Seconds, from a Retry-After header. */
  retryAfterS?: number;
}

export interface EmailProvider {
  readonly name: "resend" | "mock" | "null";
  send(msg: OutgoingEmail): Promise<ProviderResult>;
}

export type EmailEnvVars = Record<string, string | undefined>;

/** Thrown when code tries to reach the real Resend API from a test run. Never swallowed. */
export class LiveSendBlockedError extends Error {
  constructor() {
    super("live Resend call refused: tests never reach api.resend.com");
    this.name = "LiveSendBlockedError";
  }
}

/** Thrown when a message is addressed to anyone but the configured Owner recipient (EML-003b). */
export class RecipientGuardError extends Error {
  constructor() {
    super("recipient guard: only the configured Owner address may receive email");
    this.name = "RecipientGuardError";
  }
}

export const RESEND_HOST = "api.resend.com";

/** Vitest sets VITEST; it and NODE_ENV=test both mean "a test run" (the process counts too). */
export function isTestRuntime(env: EmailEnvVars): boolean {
  const own = Boolean(env.VITEST) || env.NODE_ENV === "test";
  return own || Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

export const NULL_PROVIDER: EmailProvider = {
  name: "null",
  async send() {
    return { outcome: "rejected" };
  },
};

const MAILBOX = /^[^\s,;<>"()[\]\\@]+@[^\s,;<>"()[\]\\@]+\.[^\s,;<>"()[\]\\@]+$/;

/** Normalised Owner address (one mailbox, no list or header injection), else null. */
export function ownerAddress(env: EmailEnvVars): string | null {
  const v = (env.OWNER_EMAIL ?? "").trim().toLowerCase();
  return MAILBOX.test(v) ? v : null;
}

/** Wraps a provider so that nothing is ever addressed to anyone but the Owner. */
export function guardRecipient(inner: EmailProvider, owner: string): EmailProvider {
  return {
    name: inner.name,
    send(msg) {
      if (msg.to.trim().toLowerCase() !== owner.trim().toLowerCase()) {
        throw new RecipientGuardError();
      }
      return inner.send(msg);
    },
  };
}
