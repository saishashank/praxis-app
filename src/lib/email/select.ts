// Provider selection (M5 T3, design 4.9, D-096 decision 44): EMAIL_PROVIDER picks resend, mock or null.
// Anything else is `null` (fail closed). Under Vitest (or NODE_ENV=test) `resend` becomes the mock
// unless a test injects its own fetch. Staging is the mock except ONE live "[STAGING]" email per
// process when EMAIL_LIVE=1 (EML-004, NFR-040).
import { createMockProvider } from "./mock";
import { isTestRuntime, NULL_PROVIDER, type EmailEnvVars, type EmailProvider } from "./provider";
import { createResendProvider } from "./resend";

/** The single live staging email allowed per process (reset only by tests). */
let stagingLiveUsed = false;
export function resetStagingLiveSlot(): void {
  stagingLiveUsed = false;
}

export interface SelectDeps {
  fetchImpl?: typeof fetch;
  mock?: EmailProvider;
}

export function selectProvider(env: EmailEnvVars, deps: SelectDeps = {}): EmailProvider {
  const mock = deps.mock ?? createMockProvider();
  const want = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (want === "mock") return mock;
  if (want !== "resend") return NULL_PROVIDER;
  if (isTestRuntime(env) && !deps.fetchImpl) return mock;
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return NULL_PROVIDER;
  const live = createResendProvider({ apiKey, fetchImpl: deps.fetchImpl, env });
  if (env.PRAXIS_ENV === "staging") {
    if (env.EMAIL_LIVE !== "1") return mock;
    return {
      name: "resend",
      send(msg) {
        if (stagingLiveUsed) return mock.send(msg);
        stagingLiveUsed = true;
        return live.send(msg);
      },
    };
  }
  return live;
}
