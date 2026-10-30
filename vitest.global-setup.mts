// Vitest global setup: the whole run writes its temporary files into one folder that is removed at
// the end (scripts/test/runTemp.mjs). Runs in the main process before the workers start, so the
// workers inherit TEMP / TMP / TMPDIR.
import { useRunTemp } from "./scripts/test/runTemp.mjs";

export default function setup(): () => void {
  return useRunTemp();
}
