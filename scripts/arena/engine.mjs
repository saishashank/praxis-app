// Loads the TypeScript arena engine (src/lib/arena/cli.ts) from a plain .mjs entry point. The
// engine imports with the "@/" alias and ".ts" modules, which plain Node cannot run, so it is
// bundled first with Vite's SSR build (already a dev dependency through Vitest) into
// node_modules/.cache/praxis-arena/, a folder that is never committed and that resolves
// "@libsql/client" from the repo's node_modules. Nothing is downloaded; no secret is read here.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// One folder per process: parallel test files (signals, close-books) used to share one folder,
// and `emptyOutDir` of one build deleted the bundle the other was about to import.
const OUT_DIR = path.join(
  ROOT,
  "node_modules",
  ".cache",
  "praxis-arena",
  `${process.pid}-${randomBytes(4).toString("hex")}`,
);

/** Bundle src/lib/arena/cli.ts and return its exports ({ closeBooksMain, replayMain }). */
export async function loadEngine() {
  const { build } = await import("vite");
  mkdirSync(OUT_DIR, { recursive: true });
  const built = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": path.join(ROOT, "src") } },
    build: {
      ssr: path.join(ROOT, "src", "lib", "arena", "cli.ts"),
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
  if (!entry) throw new Error("arena engine bundle has no entry chunk");
  return import(pathToFileURL(path.join(OUT_DIR, entry.fileName)).href);
}
