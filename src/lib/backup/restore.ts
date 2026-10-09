// Restore side of the shared backup core. A stream whose end-line counts or sha256 do not match
// is refused before anything is written (TST-108).
export { decodeValue, parseBackup, restoreDatabase } from "../../../scripts/backup/core.mjs";
