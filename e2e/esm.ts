// Playwright loads spec files as CommonJS, which cannot require the zero-dependency .mjs CI scripts
// (they use import.meta). A real dynamic import() gets around that; `new Function` stops the
// transpiler from rewriting it into require().
import path from "node:path";
import { pathToFileURL } from "node:url";

export function importEsm<T>(fromRepoRoot: string): Promise<T> {
  const url = pathToFileURL(path.resolve(__dirname, "..", fromRepoRoot)).href;
  return new Function("u", "return import(u)")(url) as Promise<T>;
}
