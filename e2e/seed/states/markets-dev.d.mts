import type { Client } from "@libsql/client";

export function marketsFromEnv(env?: Record<string, string | undefined>): string[];
export function apply(
  client: Client,
  nowIso?: string,
  env?: Record<string, string | undefined>,
): Promise<string[]>;
