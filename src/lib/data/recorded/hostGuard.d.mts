export const BLOCKED_HOST_SUFFIXES: readonly string[];
export function isBlockedHost(host: string): boolean;
export function isLoopbackHost(host: string): boolean;
export function isStaging(env: Record<string, string | undefined>): boolean;
export function isRecorded(env: Record<string, string | undefined>): boolean;
export class BlockedHostError extends Error {
  constructor(message?: string);
}
export function recordRefusal(env: Record<string, string | undefined>, label?: string): void;
export function writeGuardMarker(env: Record<string, string | undefined>, label?: string): void;
export function parseNetLog(text: string): { refused: number; markers: string[] };
export function assertAllowedRequest(input: unknown, env: Record<string, string | undefined>): void;
export function guardFetch(
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined>,
): typeof fetch;
export function installHostGuard(
  env: Record<string, string | undefined>,
  target?: { fetch: typeof fetch },
): () => void;
export function connectHost(args: unknown[]): string | null;
export function installNetGuard(
  env: Record<string, string | undefined>,
  net: { Socket: { prototype: unknown } },
): () => void;
