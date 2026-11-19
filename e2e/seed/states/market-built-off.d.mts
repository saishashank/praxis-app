import type { Client } from "@libsql/client";

export const PRODUCTION_MARKETS: string[];
export const BUILT_MARKETS: string[];
export function apply(client: Client): Promise<void>;
