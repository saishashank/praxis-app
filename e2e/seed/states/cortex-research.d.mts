import type { Client } from "@libsql/client";

export const LOOKS: { lineage: string; verdict: string; n: number; blocks: number; name: string }[];
export const GROUPS: string[];
export const QUARTER: string;
export function apply(client: Client, nowIso: string): Promise<void>;
