// Knowledge-base fetch rules for expert feeds (AT-39, KB-082 contract; M18 TST-135 (b), D-967). Pure and
// network-free: the caller passes `fetch`, the validator store and the day's request counter, so M22's polling
// is a thin loop around these functions and the four AT-39 clauses are provable now with fixture feeds.
//   - robots.txt: a path the file disallows for our agent is never requested;
//   - conditional requests: the stored ETag / Last-Modified go out as If-None-Match / If-Modified-Since, a
//     304 records nothing and keeps the validators;
//   - daily cap: every request (robots.txt included) counts, the n+1-th is not made;
//   - what is recorded: link, title, time and our own short summary, never the post's text (feed
//     `description` / `content` are not read at all); hostile text in a title is stored as data and cannot
//     change the extraction rules (they are a frozen constant here, not read from the feed).
// The only fetcher of expert pages. The licence register rows for these channels stay `pending` (DAT-227);
// nothing calls this in production until M22 wires it behind the Owner's acceptance.
export const EXTRACTION_RULES = Object.freeze({
  maxItems: 100, // threshold-ok: items taken from one feed
  maxTitleChars: 300, // threshold-ok: title cap
  maxSummaryChars: 160, // threshold-ok: our own summary cap
  fields: ["link", "title", "time"] as const,
});

export type RecordedItem = {
  readonly source: string;
  readonly url: string;
  readonly title: string;
  /** ISO time the post says it was published, or null when the feed gave none we could read. */
  readonly publishedAt: string | null;
  /** Our own short summary (never the post's text). */
  readonly summary: string;
};

// ---- robots.txt ----------------------------------------------------------------------------------------

export type RobotsRules = {
  readonly groups: readonly { agents: string[]; rules: [boolean, string][] }[];
};

/** Parses the groups of a robots.txt (User-agent, Allow, Disallow); comments and unknown lines are ignored. */
export function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: [boolean, string][] }[] = [];
  let cur: { agents: string[]; rules: [boolean, string][] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (cur === null || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur !== null && (key === "allow" || key === "disallow"))
      cur.rules.push([key === "allow", val]);
  }
  return { groups };
}

/** Longest matching rule wins; Allow beats Disallow on a tie; no rule or an empty Disallow = allowed. */
export function robotsAllows(rules: RobotsRules, agent: string, path: string): boolean {
  const a = agent.toLowerCase();
  const own = rules.groups.filter((g) => g.agents.some((x) => x !== "*" && a.includes(x)));
  const groups = own.length > 0 ? own : rules.groups.filter((g) => g.agents.includes("*"));
  let best: { len: number; allow: boolean } | null = null;
  for (const g of groups) {
    for (const [allow, pattern] of g.rules) {
      if (pattern === "") continue;
      const p = pattern.replace(/\$$/, "");
      const hit = pattern.endsWith("$") ? path === p : path.startsWith(p);
      if (!hit) continue;
      if (best === null || p.length > best.len || (p.length === best.len && allow)) {
        best = { len: p.length, allow };
      }
    }
  }
  return best === null ? true : best.allow;
}

// ---- conditional requests ------------------------------------------------------------------------------

export type Validators = { etag?: string; lastModified?: string };

/** The request headers that make a fetch conditional; empty when nothing was stored. */
export function conditionalHeaders(v: Validators | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (v?.etag) h["if-none-match"] = v.etag;
  if (v?.lastModified) h["if-modified-since"] = v.lastModified;
  return h;
}

// ---- feed parsing (links, titles, times only) ----------------------------------------------------------

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m === null ? null : decode(m[1]!);
};

const isoOrNull = (s: string | null): string | null => {
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** RSS 2.0 `<item>` and Atom (including YouTube channel) `<entry>`; only link, title and time are read. */
export function parseFeed(
  xml: string,
): { url: string; title: string; publishedAt: string | null }[] {
  const out: { url: string; title: string; publishedAt: string | null }[] = [];
  for (const m of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const block = m[2]!;
    let link = tag(block, "link");
    if (link === null || link === "") {
      const href = /<link\b[^>]*?href\s*=\s*["']([^"']+)["']/i.exec(block);
      link = href === null ? null : decode(href[1]!);
    }
    const title = tag(block, "title");
    if (link === null || title === null || !/^https:\/\//i.test(link)) continue;
    out.push({
      url: link,
      title: title.slice(0, EXTRACTION_RULES.maxTitleChars),
      publishedAt: isoOrNull(
        tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated"),
      ),
    });
    if (out.length >= EXTRACTION_RULES.maxItems) break;
  }
  return out;
}

/** Our own summary: a fixed template over the title and host. The post's text is never an input. */
export function summaryOf(source: string, title: string, url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return `${source}: ${title}${host ? ` (${host})` : ""}`.slice(
    0,
    EXTRACTION_RULES.maxSummaryChars,
  );
}

// ---- the poll ------------------------------------------------------------------------------------------

export type FetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};
export type FetchFn = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<FetchResponse>;
export type PollState = {
  /** Stored validators per feed URL. */
  validators: Map<string, Validators>;
  /** Requests made so far per day key (YYYY-MM-DD). */
  requests: Map<string, number>;
};
export const newPollState = (): PollState => ({ validators: new Map(), requests: new Map() });

export type PollReport = {
  requested: number;
  recorded: number;
  notModified: number;
  disallowed: string[];
  capped: string[];
  failed: string[];
};

export type PollInput = {
  sources: readonly { id: string; url: string }[];
  fetch: FetchFn;
  state: PollState;
  /** The day key the cap counts against. */
  day: string;
  /** Requests allowed in a day (robots.txt requests included). */
  dailyCap: number;
  /** Our identifying User-Agent. */
  agent: string;
  record: (item: RecordedItem) => void;
};

/** One pass over the sources. Never throws: a failed request is reported by source id. */
export async function pollFeeds(i: PollInput): Promise<PollReport> {
  const rep: PollReport = {
    requested: 0,
    recorded: 0,
    notModified: 0,
    disallowed: [],
    capped: [],
    failed: [],
  };
  const robots = new Map<string, RobotsRules | null>();
  const budget = (): boolean => (i.state.requests.get(i.day) ?? 0) < i.dailyCap;
  const spend = (): void => {
    i.state.requests.set(i.day, (i.state.requests.get(i.day) ?? 0) + 1);
    rep.requested += 1;
  };
  for (const s of i.sources) {
    let u: URL;
    try {
      u = new URL(s.url);
    } catch {
      rep.failed.push(s.id);
      continue;
    }
    if (u.protocol !== "https:") {
      rep.failed.push(s.id);
      continue;
    }
    if (!robots.has(u.origin)) {
      if (!budget()) {
        rep.capped.push(s.id);
        continue;
      }
      spend();
      try {
        const r = await i.fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": i.agent } });
        robots.set(
          u.origin,
          r.status >= 200 && r.status < 300 ? parseRobots(await r.text()) : null,
        );
      } catch {
        robots.set(u.origin, null); // no readable robots.txt: treated as allowing, as the standard says
      }
    }
    const rules = robots.get(u.origin);
    if (
      rules !== null &&
      rules !== undefined &&
      !robotsAllows(rules, i.agent, u.pathname + u.search)
    ) {
      rep.disallowed.push(s.id);
      continue;
    }
    if (!budget()) {
      rep.capped.push(s.id);
      continue;
    }
    spend();
    try {
      const headers = {
        "user-agent": i.agent,
        ...conditionalHeaders(i.state.validators.get(s.url)),
      };
      const r = await i.fetch(s.url, { headers });
      if (r.status === 304) {
        rep.notModified += 1;
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        rep.failed.push(s.id);
        continue;
      }
      const items = parseFeed(await r.text());
      for (const it of items) {
        i.record({
          source: s.id,
          url: it.url,
          title: it.title,
          publishedAt: it.publishedAt,
          summary: summaryOf(s.id, it.title, it.url),
        });
        rep.recorded += 1;
      }
      const v: Validators = {};
      const etag = r.headers.get("etag");
      const lm = r.headers.get("last-modified");
      if (etag) v.etag = etag;
      if (lm) v.lastModified = lm;
      if (v.etag || v.lastModified) i.state.validators.set(s.url, v);
    } catch {
      rep.failed.push(s.id);
    }
  }
  return rep;
}
