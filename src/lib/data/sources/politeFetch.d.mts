import type { Client } from "@libsql/client";
import type { MarketSourceRow, MarketSite } from "../../market/seed/sourceSites.mjs";

export const DEFAULT_USER_AGENT: string;
export const ROBOTS_TOKEN: string;
export const MAX_RETRIES: number;
export const BACKOFF_BASE_MS: number;
export const RETRY_AFTER_CAP_MS: number;
export const ROBOTS_TTL_MS: number;
export const DEFAULT_INTERVAL_MS: number;
export const REFUSALS: readonly string[];
export class PoliteFetchRefused extends Error {
  constructor(reason: string);
  reason: string;
}
export function isPoliteFetchRefused(e: unknown): e is PoliteFetchRefused;
export function parseRobots(
  text: string,
  token?: string,
): { allows: (pathAndQuery: string) => boolean; crawlDelayMs: number };
export function dbGate(
  db: Pick<Client, "execute">,
  o?: { ttlMs?: number; now?: () => number },
): (row: { id: string; market: string }) => Promise<string | null>;
export type PoliteFetchOptions = {
  db?: Pick<Client, "execute">;
  gate?: (row: MarketSourceRow) => Promise<string | null> | string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  env?: Record<string, string | undefined>;
  log?: (e: { host: string; status: number | string }) => void;
  siteOf?: (host: string) => (Pick<MarketSite, "sources"> & { host: string }) | null;
  sourceOf?: (id: string) => MarketSourceRow | undefined;
  backoffBaseMs?: number;
  timeoutMs?: number;
};
export function createPoliteFetch(o?: PoliteFetchOptions): {
  fetch(
    input: string | URL,
    init?: RequestInit & { source?: string; userAgent?: string },
  ): Promise<Response>;
};
