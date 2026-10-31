// Live status overlay interface (ARC-002). WP4 supplies the real loader; until it lands every element
// is "unknown". Read-only: nothing here calls out or writes.
export type BpStatus = { state: "ok" | "warn" | "bad" | "unknown"; line: string };

export function statusOf(id: string): BpStatus {
  void id;
  return { state: "unknown", line: "Live status not connected yet." };
}
