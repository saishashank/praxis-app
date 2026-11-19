// Fixture pages and a recording fetch for the licence tests (M22 E1). No network, no real host: every URL is on
// example.test or the platform's own public origin, and the pages are synthetic.
import type { SourceFetch } from "@/lib/experts/licence/engine.mjs";

export const ROBOTS_ALLOW = "User-agent: *\nDisallow: /private/\n";
export const ROBOTS_DENY = "User-agent: *\nDisallow: /\n";
export const ROBOTS_DENY_PRAXIS = "User-agent: praxis\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
export const TERMS_FORBID =
  "<html><body><h1>Terms</h1><p>You may not scrape, crawl or summarise our posts by automated means.</p></body></html>";
export const TERMS_PERMIT =
  "<html><body><h1>Terms</h1><p>You may summarise and quote our posts with a link back.</p></body></html>";
export const TERMS_SILENT =
  "<html><body><h1>Terms</h1><p>These terms apply to the use of this site. Be kind.</p></body></html>";

export type Reply = { status: number; text?: string; location?: string } | "throw";

/** A fetch that answers from a table (url -> reply; anything else is a 404) and records every url asked. */
export function fixtureFetch(table: Record<string, Reply>): {
  fetch: SourceFetch;
  asked: string[];
} {
  const asked: string[] = [];
  const fetch: SourceFetch = async (url) => {
    asked.push(url);
    const r = table[url] ?? { status: 404 };
    if (r === "throw") throw new Error("network");
    return {
      status: r.status,
      headers: { get: (n) => (n.toLowerCase() === "location" ? (r.location ?? null) : null) },
      text: async () => r.text ?? "",
    };
  };
  return { fetch, asked };
}

export const noSleep = async (): Promise<void> => undefined;
