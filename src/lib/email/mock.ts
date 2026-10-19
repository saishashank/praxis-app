// Mock email provider (M5 T3, design 4.9): records to an in-memory outbox, returns deterministic
// `mock-<n>` ids and never touches the network. A repeated Idempotency-Key returns the first id and
// is not recorded again, like the real provider's window. `script` queues provider answers for
// failure tests (consumed one per call, then back to accepting).
import type { EmailProvider, OutgoingEmail, ProviderResult } from "./provider";

export interface MockProvider extends EmailProvider {
  readonly outbox: OutgoingEmail[];
  /** Every call, including scripted failures and idempotent repeats. */
  readonly calls: OutgoingEmail[];
  script: ProviderResult[];
}

export function createMockProvider(script: ProviderResult[] = []): MockProvider {
  const outbox: OutgoingEmail[] = [];
  const calls: OutgoingEmail[] = [];
  const ids = new Map<string, string>();
  const p: MockProvider = {
    name: "mock",
    outbox,
    calls,
    script: [...script],
    async send(msg) {
      calls.push(msg);
      const next = p.script.shift();
      if (next) return next;
      const seen = ids.get(msg.idempotencyKey);
      if (seen) return { outcome: "accepted", providerId: seen, httpStatus: 200 };
      const id = `mock-${ids.size + 1}`;
      ids.set(msg.idempotencyKey, id);
      outbox.push(msg);
      return { outcome: "accepted", providerId: id, httpStatus: 200 };
    },
  };
  return p;
}
