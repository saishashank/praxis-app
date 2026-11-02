// Search by element name, id or spec ID (UXN-298). Case-insensitive substring; exact spec-ID
// matches rank first, then name matches, then the rest, each group in id order.
import type { BpElement } from "./types";

export function searchElements(elements: BpElement[], query: string, limit = 30): BpElement[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: Array<[number, BpElement]> = [];
  for (const e of elements) {
    const spec = e.specIds.map((s) => s.toLowerCase());
    let score = -1;
    if (spec.includes(q)) score = 0;
    else if (spec.some((s) => s.includes(q))) score = 1;
    else if (e.name.toLowerCase().includes(q)) score = 2;
    else if (e.id.toLowerCase().includes(q)) score = 3;
    if (score >= 0) scored.push([score, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1].id < b[1].id ? -1 : a[1].id > b[1].id ? 1 : 0));
  return scored.slice(0, limit).map(([, e]) => e);
}
