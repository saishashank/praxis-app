// Attention items for the snooze control (M5 T2, EML-023, docs/M5_design.md 4.7, 3).
//
// The snooze action must not trust the browser about an item's state: whether an item is red (down)
// or within 2 days of its deadline decides if it can be snoozed at all. It therefore reads the item
// from the latest `health_snapshot` (purpose `reminder`), which the nightly health function (T13)
// writes. The contract T13 writes (D-097):
//   components_json = { "components": [ { "id": <HealthComponent>, "state": "healthy"|"attention"|"down",
//     "items": [ { "key": <item key>, "label": <text>, "state": "attention"|"down",
//                  "deadline_d": <YYYY-MM-DD>|null } ] } ] }
// Anything that does not match is ignored (an unreadable snapshot gives no snoozable items).
import type { Client } from "@libsql/client";
import { HEALTH_COMPONENTS, type HealthComponent } from "@/lib/sentinel/schema";

export type AttentionItem = {
  component: HealthComponent;
  key: string;
  label: string;
  state: "attention" | "down";
  deadlineD: string | null;
};

const KEY_RE = /^[a-z0-9_.:-]{1,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses the snapshot JSON into the items it lists; tolerant: bad entries are skipped. */
export function parseAttentionItems(componentsJson: unknown): AttentionItem[] {
  let parsed: unknown = componentsJson;
  if (typeof componentsJson === "string") {
    try {
      parsed = JSON.parse(componentsJson);
    } catch {
      return [];
    }
  }
  if (!isObj(parsed) || !Array.isArray(parsed.components)) return [];
  const out: AttentionItem[] = [];
  for (const c of parsed.components) {
    if (!isObj(c) || !(HEALTH_COMPONENTS as readonly unknown[]).includes(c.id)) continue;
    if (!Array.isArray(c.items)) continue;
    for (const it of c.items) {
      if (!isObj(it)) continue;
      if (typeof it.key !== "string" || !KEY_RE.test(it.key)) continue;
      if (it.state !== "attention" && it.state !== "down") continue;
      const deadline =
        typeof it.deadline_d === "string" && DATE_RE.test(it.deadline_d) ? it.deadline_d : null;
      out.push({
        component: c.id as HealthComponent,
        key: it.key,
        label: typeof it.label === "string" ? it.label.slice(0, 200) : it.key,
        state: it.state,
        deadlineD: deadline,
      });
    }
  }
  return out;
}

/** The open attention items of the latest reminder snapshot (newest date). */
export async function loadAttentionItems(db: Pick<Client, "execute">): Promise<AttentionItem[]> {
  const r = await db.execute({
    sql: "SELECT components_json FROM health_snapshot WHERE purpose = 'reminder' ORDER BY d DESC LIMIT 1",
    args: [],
  });
  return r.rows.length ? parseAttentionItems(r.rows[0].components_json) : [];
}

/** One item of the latest snapshot, or null when it is not listed. */
export async function findAttentionItem(
  db: Pick<Client, "execute">,
  component: string,
  key: string,
): Promise<AttentionItem | null> {
  const items = await loadAttentionItems(db);
  return items.find((i) => i.component === component && i.key === key) ?? null;
}
