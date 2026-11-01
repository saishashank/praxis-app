// One positive "this is staging" signal (V1-I9 / D-782). Never inferred from absent secrets.
// Staging is a separate Vercel project, so VERCEL_ENV does not tell the two apart; instead either
//   (a) PRAXIS_ENV is "staging" (case-insensitive; any other non-empty value is an explicit veto), or
//   (b) the host of APP_BASE_URL has a hyphen-separated part "staging" in one of its labels
//       (staging.example.com, praxis-app-staging.vercel.app). "notstaging-ish.com" does not qualify.
export type EnvKindVars = Record<string, string | undefined>;

export function hostLooksStaging(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host.split(".").some((label) => label.split("-").includes("staging"));
}

export function isStagingEnv(env: EnvKindVars): boolean {
  const label = env.PRAXIS_ENV?.trim().toLowerCase();
  // An explicit PRAXIS_ENV decides alone: "production" is never overridden by a host name.
  if (label) return label === "staging";
  return hostLooksStaging(env.APP_BASE_URL);
}
