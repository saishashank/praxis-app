// State `labels-queue` (M21 A1, D-1236, D-1227; UXN-318): three AU announcements waiting for a golden-set label and no
// `golden_label` row, so /cortex/labels shows "0 of 500" and the first item from stored rows. Titles are synthetic and
// plain; codes are ZZ-prefixed. Idempotent: (source, ann_id) is unique, so a second apply is ignored.
export const ANNOUNCEMENTS = [
  [
    "e2e-labels-1",
    "ZZLA",
    "ZZ Labels A Ltd lifts full-year profit guidance after a strong second half",
    "results",
  ],
  [
    "e2e-labels-2",
    "ZZLB",
    "ZZ Labels B Ltd announces a trading update and reaffirms its outlook",
    "update",
  ],
  [
    "e2e-labels-3",
    "ZZLC",
    "ZZ Labels C Ltd completes a share buy-back and cancels the shares",
    "buyback",
  ],
];

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const base = Date.parse(nowIso);
  await client.batch(
    ANNOUNCEMENTS.map(([annId, code, title, type], i) => ({
      sql: `INSERT OR IGNORE INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
            VALUES ('AU', ?, ?, ?, ?, ?, 1, ?, NULL, 'asx')`,
      // oldest first, one hour apart, so the order the page shows is fixed
      args: [
        code,
        annId,
        new Date(base - (ANNOUNCEMENTS.length - i) * 3_600_000).toISOString(),
        nowIso,
        type,
        title,
      ],
    })),
    "write",
  );
}
