// age encryption helpers of the shared backup core (PLT-022b). The server only ever holds the
// PUBLIC key (BACKUP_PUBLIC_KEY); decryptBytes/decryptToText exist for tests and the drill.
export {
  decryptBytes,
  decryptToText,
  encryptBytes,
  exportEncrypted,
  looksLikeAge,
  parseRecipient,
} from "../../../scripts/backup/core.mjs";
