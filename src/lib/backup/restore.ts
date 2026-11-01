// Restore side of the shared backup core. A stream whose end-line counts or sha256 do not match
// is refused before anything is written (TST-108). V1-S5/V1-S6: bounded batches with a checkpoint,
// parents before children.
export {
  decodeValue,
  foreignKeyOrder,
  parseBackup,
  referencedTables,
  RESTORE_CHECKPOINT_TABLE,
  RESTORE_CHUNK_STATEMENTS,
  restoreDatabase,
} from "../../../scripts/backup/core.mjs";
