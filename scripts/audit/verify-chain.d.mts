import type { Client } from "@libsql/client";
export function verifyChain(
  db: Pick<Client, "execute">,
  piiHashKey: string,
): Promise<{ rows: number; brokenId: number | null }>;
export function run(
  env: Record<string, string | undefined>,
  makeClient: (url: string, token?: string) => Pick<Client, "execute"> & { close?: () => void },
  out: (line: string) => void,
): Promise<number>;
