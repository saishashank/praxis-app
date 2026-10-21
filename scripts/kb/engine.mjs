// Loads the TypeScript KB archive entry (src/lib/kb/archiveCli.ts) from a plain .mjs script. Bundled like
// scripts/llm/engine.mjs with Vite's SSR build into node_modules/.cache/praxis-kb/ (never committed).
// Nothing is downloaded; no secret is read here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "node_modules", ".cache", "praxis-kb");

/** Bundle src/lib/kb/archiveCli.ts and return its exports ({ archiveMain, ... }). */
export async function loadArchive() {
  const { build } = await import("vite");
  mkdirSync(OUT_DIR, { recursive: true });
  const built = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": path.join(ROOT, "src") } },
    build: {
      ssr: path.join(ROOT, "src", "lib", "kb", "archiveCli.ts"),
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
  if (!entry) throw new Error("kb archive bundle has no entry chunk");
  return import(pathToFileURL(path.join(OUT_DIR, entry.fileName)).href);
}
