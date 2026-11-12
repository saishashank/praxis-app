import type { AnnouncementItem, CategoryMap, Classified } from "../cortex/profileReaders";

export function classify(map: CategoryMap, item: AnnouncementItem): Classified;
export function writeAnnouncementCategory(
  db: { execute: (q: never) => Promise<unknown> },
  key: { readonly market: string; readonly source: string; readonly annId: string },
  map: CategoryMap,
  item: AnnouncementItem,
): Promise<Classified>;
