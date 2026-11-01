import type { Client } from "@libsql/client";

export type Migration = {
  version: number;
  name: string;
  checksum: string;
  up: string[];
  down: string[];
};

export function splitStatements(text: string): string[];
export function parseMigration(content: string, file: string): { up: string[]; down: string[] };
export function loadMigrations(dir: string): Promise<Migration[]>;
export function migrateUp(
  db: Client,
  migrations: Migration[],
  opts?: { allowNewer?: boolean },
): Promise<{ applied: number; version: number; newer?: number[] }>;
export function migrateDown(
  db: Client,
  migrations: Migration[],
  n: number,
): Promise<{ rolledBack: number; version: number }>;
export function migrateDownTo(
  db: Client,
  migrations: Migration[],
  target: number,
): Promise<{ rolledBack: number; version: number }>;
