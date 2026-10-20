// Loads the TypeScript deadline checker (src/lib/runs/deadlines.ts) from a plain .mjs entry point,
// bundled with Vite's SSR build exactly like scripts/watchdog/lib.mjs: into
// node_modules/.cache/praxis-e2e-day/ (never committed), "@libsql/client" resolved from the repo's
// node_modules. Nothing is downloaded; no secret is read here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "node_modules", ".cache", "praxis-e2e-day");

export async function loadDeadlines() {
  const { build } = await import("vite");
  mkdirSync(OUT_DIR, { recursive: true });
  const built = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": path.join(ROOT, "src") } },
    build: {
      ssr: path.join(ROOT, "src", "lib", "runs", "deadlines.ts"),
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      target: "node22",
    },
    ssr: { external: ["@libsql/client"] },
  });
  const result = Array.isArray(built) ? built[0] : built;
  const entry = result.output.find((o) => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("deadline checker bundle has no entry chunk");
  return import(pathToFileURL(path.join(OUT_DIR, entry.fileName)).href);
}
