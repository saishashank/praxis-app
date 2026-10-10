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
): Promise<{ applied: number; version: number }>;
export function migrateDown(
  db: Client,
  migrations: Migration[],
  n: number,
): Promise<{ rolledBack: number; version: number }>;
