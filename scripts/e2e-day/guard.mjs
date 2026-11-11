// Preload for every Node process of the CI recorded day (M18 OPS-107 / D-965): `node --import
// scripts/e2e-day/guard.mjs <script>`. It refuses to run outside PRAXIS_ENV=recorded, installs the host
// guard (fetch and net connects: every non-loopback host is refused and counted in $PRAXIS_NET_LOG) and
// writes this process's marker ($PRAXIS_NET_LABEL), so the job's last step can prove no process ran
// without it. A process that is not guarded does not write a marker and the job fails.
import net from "node:net";
import {
  installHostGuard,
  installNetGuard,
  isRecorded,
  writeGuardMarker,
} from "../../src/lib/data/recorded/hostGuard.mjs";

if (!isRecorded(process.env)) {
  console.error("guard: PRAXIS_ENV must be recorded");
  process.exit(2);
}
installHostGuard(process.env);
installNetGuard(process.env, net);
writeGuardMarker(process.env);
