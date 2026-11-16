// Static guard-coverage checks for hidden routes (M21 A2, D-1210, D-1247). Pure functions over source text so the tests can
// plant a bad file and watch the check fail. A page, a route handler and a server action are three different ways in:
// Next dispatches a server action by its Next-Action id from ANY page URL, so an action under (owner-tools) must guard
// itself; it cannot rely on the page or the proxy.
import { hiddenEntryFor, type HiddenRoute } from "@/lib/http/hiddenRoutes";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** The URL of a page.tsx / route.ts file under src/app: route groups removed, slots kept (they are not addresses). */
export function urlOf(file: string): string {
  const rel = file.replace(/^src\/app\//, "").replace(/\/?(?:page|route)\.(?:tsx|ts)$/, "");
  return (
    "/" +
    rel
      .split("/")
      .filter((x) => x && !(x.startsWith("(") && x.endsWith(")")))
      .join("/")
  );
}

/** The name of the first awaited call in a body, ignoring params / searchParams / cookies-free reads. */
export function firstAwait(body: string): string | undefined {
  return [...body.matchAll(/await\s+([A-Za-z_$][\w$]*)/g)].filter(
    (m) => m[1] !== "params" && m[1] !== "searchParams",
  )[0]?.[1];
}

/** Bodies of exported functions: `export [default] [async] function name` and `export const name = [async] (`. */
export function exportedFunctions(text: string): { name: string; body: string }[] {
  const re =
    /(?:^|\n)export\s+(?:default\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=)/g;
  const found = [...text.matchAll(re)].map((m) => ({
    name: /^\n?export\s+default\b/.test(m[0]) ? "default" : (m[1] ?? m[2] ?? "default"),
    at: m.index!,
  }));
  return found.map((f, i) => ({
    name: f.name,
    body: text.slice(f.at, found[i + 1]?.at ?? text.length),
  }));
}

export const isUseServer = (text: string): boolean =>
  /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use server["']/.test(text);

/** Problems with one file; an empty list means the guard rules hold for it. */
export function checkHiddenFile(file: string, text: string): string[] {
  const problems: string[] = [];
  const inSection = file.startsWith("src/app/(app)/(owner-tools)/");
  const isPage = /\/page\.tsx$/.test(file);
  const isRoute = /\/route\.ts$/.test(file);
  if (isPage || isRoute) {
    const entry: HiddenRoute | null = hiddenEntryFor(urlOf(file));
    if (inSection && !entry) {
      problems.push(
        `${file}: lives under (owner-tools) but its URL is not under a HIDDEN_ROUTES prefix`,
      );
    }
    if (entry && isPage) {
      const fns = exportedFunctions(text);
      const page = fns.find((f) => f.name === "default");
      if (!page || firstAwait(page.body) !== entry.guard) {
        problems.push(`${file}: the default export must call ${entry.guard} first`);
      }
      const meta = fns.find((f) => f.name === "generateMetadata");
      if (meta && firstAwait(meta.body) !== entry.guard) {
        problems.push(`${file}: generateMetadata must call ${entry.guard} first`);
      }
    }
    if (entry && isRoute) {
      const handlers = exportedFunctions(text).filter((f) => METHODS.includes(f.name));
      if (handlers.length === 0) problems.push(`${file}: no exported HTTP method found`);
      for (const h of handlers) {
        if (firstAwait(h.body) !== entry.routeGuard) {
          problems.push(`${file}: ${h.name} must call ${entry.routeGuard} first`);
        }
      }
    }
  }
  const sectionLib = file.startsWith("src/lib/ownerTools/");
  if ((inSection || sectionLib) && isUseServer(text)) {
    for (const f of exportedFunctions(text)) {
      if (firstAwait(f.body) !== "requireOwnerTools") {
        problems.push(`${file}: server action ${f.name} must call requireOwnerTools first`);
      }
    }
  }
  return problems;
}
