// Fixture feeds and a recording fetch for the polling tests (M22 E2). No network, no real host: every URL is on
// example.test or the platform's own public origin, and every feed is synthetic.
import type { Client } from "@libsql/client";
import { appendLicence, type LicenceRow } from "@/lib/experts/licence/store";
import { PLATFORM_SITES } from "@/lib/experts/licence/engine.mjs";
import type { RawFetch } from "@/lib/experts/poll/guard";

export const YT = PLATFORM_SITES.youtube!.origin; // the platform's own public origin, never spelled out here
export const SITE = (n: number): string => `https://zz${n}.example.test`;
/** The feed address of the site source of ZZ expert n, and the YouTube channel feed of its handle. */
export const SITE_FEED = (n: number): string => `${SITE(n)}/home`;
export const YT_FEED = (n: number): string => `${YT}/feeds/videos.xml?channel_id=zz-handle-${n}`;

export type Item = { title: string; link: string; pubDate?: string };
export const rss = (items: Item[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link>${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ""}` +
        `<description>THE POST BODY MUST NEVER BE STORED</description></item>`,
    )
    .join("")}</channel></rss>`;

export type Reply =
  | {
      status: number;
      text?: string;
      location?: string;
      etag?: string;
      lastModified?: string;
    }
  | "throw";

export type Asked = { url: string; headers: Record<string, string>; redirect: string };

/** A fetch answering from a table (url -> reply; anything else is a 404) that records every request. */
export function recordingFetch(table: Record<string, Reply>): { fetch: RawFetch; asked: Asked[] } {
  const asked: Asked[] = [];
  const fetch: RawFetch = async (url, init) => {
    asked.push({ url, headers: init.headers, redirect: init.redirect });
    const r = table[url] ?? { status: 404 };
    if (r === "throw") throw new Error("network");
    const h: Record<string, string | undefined> = {
      location: r.location,
      etag: r.etag,
      "last-modified": r.lastModified,
    };
    return {
      status: r.status,
      headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
      text: async () => r.text ?? "",
    };
  };
  return { fetch, asked };
}

export const noSleep = async (): Promise<void> => undefined;
export const ROBOTS_ALLOW = "User-agent: *\nDisallow: /private/\n";
export const ROBOTS_DENY_HOME = "User-agent: *\nDisallow: /home\n";

/** One licence row for a source of an expert (default: enabled, titles and links only). */
export const licence = (
  db: Client,
  expertId: string,
  sourceKey: string,
  o: Partial<LicenceRow> = {},
): Promise<void> =>
  appendLicence(db, {
    expertId,
    sourceKey,
    checkedAt: "2030-03-01T00:00:00.000Z",
    termsUrl: null,
    robots: "allows",
    summarisation: "unknown",
    status: "enabled",
    actor: "job",
    note: null,
    ...o,
  });

export const countItems = async (db: Client, expertId?: string): Promise<number> =>
  Number(
    (
      await db.execute(
        expertId === undefined
          ? "SELECT COUNT(*) AS n FROM source_item WHERE extraction_status = 'pending'"
          : {
              sql: "SELECT COUNT(*) AS n FROM source_item WHERE extraction_status = 'pending' AND expert_id = ?",
              args: [expertId],
            },
      )
    ).rows[0]!.n,
  );

export const rowsOf = async (
  db: Client,
  sql: string,
  args: (string | number)[] = [],
): Promise<Record<string, unknown>[]> =>
  (await db.execute({ sql, args })).rows as unknown as Record<string, unknown>[];

/** Sets a configuration value in the test database (the registry validates it). */
export async function setKey(db: Client, key: string, value: unknown): Promise<void> {
  const { setConfig } = await import("@/lib/config/store");
  await setConfig(db, { key, value, userId: null, now: "2030-03-01T00:00:00.000Z" });
}
