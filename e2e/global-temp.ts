// Playwright global setup: the run's temporary files (e.g. the Lighthouse browser profile) go into
// one folder that is removed when the run ends (scripts/test/runTemp.mjs).
import { useRunTemp as claimRunTemp } from "../scripts/test/runTemp.mjs";

export default function globalSetup(): () => void {
  return claimRunTemp();
}
