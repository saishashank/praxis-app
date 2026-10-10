// Re-export of the shared backup core (scripts/backup/core.mjs) so the Vercel export route and
// the Actions scripts run ONE implementation (same pattern as src/lib/db/migrate-core.mjs).
export {
  dumpDatabase,
  encodeValue,
  EPHEMERAL_TABLES,
  FOREVER_TABLES,
  FORMAT_VERSION,
} from "../../../scripts/backup/core.mjs";
export type { DbName, Meta } from "../../../scripts/backup/core.mjs";
