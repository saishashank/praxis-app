// Loads the TypeScript watchdog engine (src/lib/watchdog/script.ts) from a plain .mjs entry point,
// bundled with Vite's SSR build exactly like scripts/arena/engine.mjs: into
// node_modules/.cache/praxis-watchdog/ (never committed), "@libsql/client" resolved from the
// repo's node_modules. Nothing is downloaded; no secret is read here.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// One folder per process, so parallel runs never empty each other's bundle (see scripts/arena/engine.mjs).
const OUT_DIR = path.join(
  ROOT,
  "node_modules",
  ".cache",
  "praxis-watchdog",
  `${process.pid}-${randomBytes(4).toString("hex")}`,
);

export async function loadWatchdogLib() {
  const { build } = await import("vite");
  mkdirSync(OUT_DIR, { recursive: true });
  const built = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": path.join(ROOT, "src") } },
    build: {
      ssr: path.join(ROOT, "src", "lib", "watchdog", "script.ts"),
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
  if (!entry) throw new Error("watchdog bundle has no entry chunk");
  return import(pathToFileURL(path.join(OUT_DIR, entry.fileName)).href);
}
