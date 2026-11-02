// Run a test command with its own Temp folder and delete the folder afterwards (see runTemp.mjs).
//   node scripts/test/with-run-temp.mjs <command> [args...]
// Exits with the command's exit code.
import { spawnSync } from "node:child_process";
import { createRunTemp, removeRunTemp } from "./runTemp.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/test/with-run-temp.mjs <command> [args...]");
  process.exit(2);
}
const { dir, env } = createRunTemp();
let code = 1;
try {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.error) console.error(r.error.message);
  code = r.status ?? 1;
} finally {
  removeRunTemp(dir);
}
process.exit(code);
