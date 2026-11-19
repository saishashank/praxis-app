// The announcement angles of the CXA-004 calibration (M23 T2; D-1635, D-1690). The set is derived from the registry, not
// listed by hand: an angle belongs to it when its entry names the announcement archive as the data it still needs AND it
// reads announcements as an input. That gives 22 angles today; the spec's "24" is a count mismatch (D-1635), and one
// entry that names the archive but reads no announcement (the index-change gate) is left out. The test pins the list and
// the count, so a registry edit that moves either one fails loudly instead of changing what a frozen plan covers.
import { ANGLES } from "./registry";
import type { AngleDef } from "./types";

/** The words of the archive data marker in an angle's `needsData` text. */
export const ARCHIVE_MARKER = "announcement archive";

/** The angles of a definition list that carry the archive marker and read announcements (registry order). */
export function announcementAngleDefs(defs: readonly AngleDef[] = ANGLES): readonly AngleDef[] {
  return defs.filter(
    (a) => (a.needsData ?? "").includes(ARCHIVE_MARKER) && a.inputs.includes("announcement"),
  );
}

/** The ids of the set, in registry order. */
export const ANNOUNCEMENT_ANGLES: readonly string[] = announcementAngleDefs().map((a) => a.id);
