export const BLOCKED_HOST_SUFFIXES: readonly string[];
export function isBlockedHost(host: string): boolean;
export function isStaging(env: Record<string, string | undefined>): boolean;
export class BlockedHostError extends Error {}
export function assertAllowedRequest(input: unknown, env: Record<string, string | undefined>): void;
export function guardFetch(
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined>,
): typeof fetch;
export function installHostGuard(
  env: Record<string, string | undefined>,
  target?: { fetch: typeof fetch },
): () => void;
