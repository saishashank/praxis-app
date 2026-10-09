import type { Client } from "@libsql/client";

export type DbName = "main" | "auth";
export type Meta = {
  kind: "meta";
  format: number;
  db: DbName;
  schema_version: number;
  created_at: string;
  tables: string[];
  ephemeral: string[];
  forever: string[];
};

export const FORMAT_VERSION: number;
export const EPHEMERAL_TABLES: Readonly<Record<DbName, readonly string[]>>;
export const FOREVER_TABLES: readonly string[];
export const KEEP_DAILY: number;
export const KEEP_WEEKLY: number;
export const KEEP_MONTHLY: number;

export function encodeValue(v: unknown): unknown;
export function decodeValue(v: unknown): null | string | number | bigint | ArrayBuffer;

export function dumpDatabase(
  db: Client,
  opts: { name: DbName; createdAt: string; ephemeral?: readonly string[] },
): Promise<{
  text: string;
  meta: Meta;
  counts: Record<string, number>;
  sha256: Record<string, string>;
}>;
export function parseBackup(text: string): {
  meta: Meta;
  schemas: { type: string; table: string; name?: string; sql: string; ephemeral: boolean }[];
  data: Map<string, { lines: string[]; rows: unknown[][] }>;
  end: { counts: Record<string, number>; sha256: Record<string, string> };
};
export function restoreDatabase(
  db: Client,
  text: string,
): Promise<{ meta: Meta; counts: Record<string, number>; sha256: Record<string, string> }>;

export function parseRecipient(value: unknown): string | null;
export function encryptBytes(plain: Uint8Array, recipient: string): Promise<Uint8Array>;
export function decryptBytes(cipher: Uint8Array, identity: string): Promise<Uint8Array>;
export function looksLikeAge(bytes: Uint8Array): boolean;
export function exportEncrypted(
  db: Client,
  opts: { name: DbName; createdAt: string; recipient: string },
): Promise<{
  data: Uint8Array;
  tables: string[];
  counts: Record<string, number>;
  sha256: Record<string, string>;
  schemaVersion: number;
}>;
export function decryptToText(cipher: Uint8Array, identity: string): Promise<string>;

export function isValidDate(d: unknown): d is string;
export function selectRetained(dates: string[], today: string): string[];
export function selectDeletions(dates: string[], today: string): string[];
export function backupTag(date: string): string;
export function assetName(db: DbName, date: string): string;
