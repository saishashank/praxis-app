// Playwright global setup: the run's temporary files (e.g. the Lighthouse browser profile) go into
// one folder that is removed when the run ends (scripts/test/runTemp.mjs).
import { useRunTemp } from "../scripts/test/runTemp.mjs";

export default function globalSetup(): () => void {
  return useRunTemp();
}
