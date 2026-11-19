import type { Client } from "@libsql/client";

export const AT: string;
export const EXPERT_A: string;
export const EXPERT_B: string;
export const NAME_A: string;
export const NAME_B: string;
export const FLAG_TEXT: string;
export const CLAIM_A: string;
export function apply(client: Client): Promise<void>;
