// Evening Review assembly (M5 T9; docs/M5_design.md 4.6; EML-010...016, 035...037, UXN-113/163).
// buildFacts reads the stored rows of the date into the renderer's fact types, assembleReview
// renders them with the T4 templates and stores one `evening_review` version, markRead records the
// first read of a date. The send loop (T10) and the watchdog fallback (T12) call these functions.
//
// Rules the code follows:
//   - every reader is bounded to the review date (EML-035): no marker or no run means the section is
//     listed as missing (partial) and its facts stay empty, never yesterday's numbers;
//   - data-only mode is not partial: sections 1-7 carry the "Arena not active" notice;
//   - a non-trading day keeps all ten headings; the minimal review shows only that date's data;
//   - versions are append-only: the same facts and kind never write a second version.
import type { Client } from "@libsql/client";
import { renderReview, type ReviewFacts } from "@/lib/email/templates";
import { dateLabel } from "@/lib/email/templates/format";
import type { EnvName } from "@/lib/email/templates/core";
import {
  canonicalFacts,
  factsSha,
  missingSections,
  storedKind,
  type Missing,
  type NarrativeKind,
  type ReviewVariant,
  type StoredKind,
} from "./facts";
import {
  loadCtx,
  narrativeFacts,
  narrativeProvenance,
  nextSession,
  readAvailability,
  readExecutions,
  readHealth,
  readHealthSummary,
  readNarrativePack,
  readNarrativeRow,
  readOrders,
  readRecap,
  readStats,
  rulesNarrative,
  unreadStreak,
} from "./sections";

export type BuildOptions = {
  market: string;
  d: string;
  env: EnvName;
  appUrl: string;
  /** Stamps the quota meter only. */
  now: Date;
  /** The watchdog / failure fallback: sections 1 (this date's data), 9 and 10 only. */
  minimal?: { reason: string };
};

export type BuiltFacts = {
  facts: ReviewFacts;
  variant: ReviewVariant;
  kind: StoredKind;
  missing: Missing[];
  narrative: NarrativeKind;
  /** The completion marker of the date exists (T10 waits for it before 20:30). */
  markerPresent: boolean;
};

const NARRATIVE_SECTIONS = [4, 5, 6];

export async function buildFacts(db: Client, o: BuildOptions): Promise<BuiltFacts> {
  const c = await loadCtx(db, o);
  const av = await readAvailability(c);
  const missing = o.minimal ? [] : missingSections(av);
  const gone = new Set(missing.map((m) => m.n));
  const minimal = o.minimal !== undefined;
  const variant: ReviewVariant = minimal
    ? "minimal"
    : !c.tradingDay
      ? "nonTrading"
      : missing.length > 0
        ? "partial"
        : "full";
  const carried = !c.tradingDay;

  // sections 1 and 3
  let executions: ReviewFacts["executions"] = [];
  if (av.arenaActive) {
    const need = minimal ? av.closeOk || carried : !gone.has(1) && !gone.has(3);
    if (need) executions = await readExecutions(c, carried);
  }
  // section 2
  let orders: ReviewFacts["orders"] = [];
  if (av.arenaActive && c.tradingDay && !minimal && !gone.has(2)) orders = await readOrders(c);

  // sections 4-6 and 7
  let narrative: ReviewFacts["narrative"] = null;
  let provenance: NarrativeKind = "rules";
  if (av.arenaActive && !minimal && NARRATIVE_SECTIONS.every((n) => !gone.has(n))) {
    const pack = await readNarrativePack(c);
    const row = c.tradingDay ? await readNarrativeRow(db, o.market, o.d) : null;
    narrative = narrativeFacts(row, rulesNarrative(pack, !c.tradingDay));
    provenance = narrativeProvenance(row);
  }
  const stats =
    av.arenaActive && !minimal && !gone.has(7) ? await readStats(c, c.tradingDay) : null;

  // sections 8 and 9
  const recap = await readRecap(c);
  const health = await readHealth(c, av);
  const hs = await readHealthSummary(c, health.lines);

  const sorted = [...executions].sort(
    (a, b) => b.dayPlCents - a.dayPlCents || (a.id < b.id ? -1 : 1),
  );
  const scorecard: ReviewFacts["scorecard"] = {
    healthyComponents: hs.healthyComponents,
    totalComponents: hs.totalComponents,
    attention: hs.attention,
  };
  if (!carried && sorted.length > 0) {
    const pick = (e: (typeof sorted)[number]) => ({
      id: e.id,
      label: e.label,
      currency: e.currency,
      dayPlCents: e.dayPlCents,
    });
    scorecard.best = pick(sorted[0]!);
    if (sorted.length > 1) scorecard.worst = pick(sorted[sorted.length - 1]!);
  }

  const facts: ReviewFacts = {
    variant,
    env: o.env,
    date: o.d,
    appUrl: o.appUrl,
    arenaActive: av.arenaActive,
    executions,
    scorecard,
    orders,
    narrative,
    stats,
    alerts: recap.alerts,
    breakerHits: recap.breakerHits,
    health: health.lines,
    suppressedEmails: health.suppressed,
  };
  const unread = await unreadStreak(db, o.d);
  if (unread > 0) facts.unreadDays = unread;
  if (variant === "partial") facts.missing = missing;
  if (recap.regimeNotice !== undefined) facts.regimeNotice = recap.regimeNotice;
  if (minimal) {
    const noData = executions.length === 0 ? ` No data for ${o.d}.` : "";
    facts.minimalReason = `${o.minimal!.reason}${noData}`;
  }
  const next = nextSession(o.d, c.calendar);
  if (next !== null) facts.nextTradingNote = `Next trading session: ${dateLabel(next)}.`;
  return {
    facts,
    variant,
    kind: storedKind(variant),
    missing,
    narrative: provenance,
    markerPresent: av.marker,
  };
}

// ---- storage ------------------------------------------------------------------------------------

export type StoredReview = {
  d: string;
  version: number;
  kind: StoredKind;
  missing: Missing[];
  factsSha: string;
  subject: string;
  html: string;
  text: string;
  markdown: string;
  sizeHtml: number;
  narrative: NarrativeKind;
  createdAt: string;
  /** False when an identical version already existed (idempotent re-run). */
  created: boolean;
};

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v);

function fromRow(r: Row, subject: string, created: boolean): StoredReview {
  return {
    d: s(r.d),
    version: Number(r.version),
    kind: s(r.kind) as StoredKind,
    missing: JSON.parse(s(r.missing_json)) as Missing[],
    factsSha: s(r.facts_sha),
    subject,
    html: s(r.html),
    text: s(r.text),
    markdown: s(r.markdown),
    sizeHtml: Number(r.size_html),
    narrative: s(r.narrative) as NarrativeKind,
    createdAt: s(r.created_at),
    created,
  };
}

/**
 * Builds, renders and stores the review of a date. The same facts and kind never write a second
 * version (idempotent per date and version); changed facts or a changed kind (partial then full)
 * append version n+1.
 */
export async function assembleReview(
  db: Client,
  o: BuildOptions & {
    createdAt?: string;
    /** Already built (T10 decided on it): not read twice. */ built?: BuiltFacts;
  },
): Promise<StoredReview & { facts: ReviewFacts; markerPresent: boolean }> {
  const built = o.built ?? (await buildFacts(db, o));
  const out = renderReview(built.facts);
  const sha = factsSha(built.facts);
  const latest = await db.execute({
    sql: "SELECT version, facts_sha, kind FROM evening_review WHERE d = ? ORDER BY version DESC LIMIT 1",
    args: [o.d],
  });
  if (
    latest.rows.length > 0 &&
    s(latest.rows[0]!.facts_sha) === sha &&
    s(latest.rows[0]!.kind) === built.kind
  ) {
    const same = await db.execute({
      sql: "SELECT * FROM evening_review WHERE d = ? AND version = ?",
      args: [o.d, Number(latest.rows[0]!.version)],
    });
    return {
      ...fromRow(same.rows[0]!, out.subject, false),
      facts: built.facts,
      markerPresent: built.markerPresent,
    };
  }
  const createdAt = o.createdAt ?? o.now.toISOString();
  const markdown = `# ${out.subject}\n\n${out.text}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cur = await db.execute({
      sql: "SELECT COALESCE(MAX(version), 0) AS v FROM evening_review WHERE d = ?",
      args: [o.d],
    });
    const version = Number(cur.rows[0]!.v) + 1;
    const ins = await db.execute({
      sql: `INSERT INTO evening_review (d, version, kind, missing_json, facts_json, facts_sha, html, text,
              markdown, size_html, narrative, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        o.d,
        version,
        built.kind,
        JSON.stringify(built.missing),
        canonicalFacts(built.facts),
        sha,
        out.html,
        out.text,
        markdown,
        out.sizeHtml,
        built.narrative,
        createdAt,
      ],
    });
    if (ins.rowsAffected > 0) {
      const row = await db.execute({
        sql: "SELECT * FROM evening_review WHERE d = ? AND version = ?",
        args: [o.d, version],
      });
      return {
        ...fromRow(row.rows[0]!, out.subject, true),
        facts: built.facts,
        markerPresent: built.markerPresent,
      };
    }
  }
  throw new Error(`evening_review ${o.d}: could not append a version`);
}

/** A stored version (the newest when `version` is omitted), or null. */
export async function loadReview(
  db: Pick<Client, "execute">,
  d: string,
  version?: number,
): Promise<StoredReview | null> {
  const r = await db.execute({
    sql:
      version === undefined
        ? "SELECT * FROM evening_review WHERE d = ? ORDER BY version DESC LIMIT 1"
        : "SELECT * FROM evening_review WHERE d = ? AND version = ?",
    args: version === undefined ? [d] : [d, version],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  return fromRow(row, "", false);
}

export async function listVersions(
  db: Pick<Client, "execute">,
  d: string,
): Promise<{ version: number; kind: StoredKind; createdAt: string }[]> {
  const r = await db.execute({
    sql: "SELECT version, kind, created_at FROM evening_review WHERE d = ? ORDER BY version",
    args: [d],
  });
  return r.rows.map((x) => ({
    version: Number(x.version),
    kind: s(x.kind) as StoredKind,
    createdAt: s(x.created_at),
  }));
}

// ---- mark as read (EML-036) ---------------------------------------------------------------------

export type ReadVia = "page" | "email_link";

export async function readState(
  db: Pick<Client, "execute">,
  d: string,
): Promise<{ readAt: string; via: ReadVia } | null> {
  const r = await db.execute({
    sql: "SELECT read_at, via FROM review_read WHERE d = ?",
    args: [d],
  });
  return r.rows.length
    ? { readAt: s(r.rows[0]!.read_at), via: s(r.rows[0]!.via) as ReadVia }
    : null;
}

/** Records the first read of a date, once (a second call is a no-op). */
export async function markRead(
  db: Pick<Client, "execute">,
  d: string,
  via: ReadVia,
  now: Date,
): Promise<{ firstRead: boolean }> {
  const r = await db.execute({
    sql: "INSERT INTO review_read (d, read_at, via) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    args: [d, now.toISOString(), via],
  });
  return { firstRead: r.rowsAffected > 0 };
}
