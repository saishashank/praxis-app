// Poll priority (M22 E2; DAT-230, D-1434). Pure: which experts are read today and in what order. Experts with a screened
// claim (a claim that survived screening) or a positive settled call record are read every day and first; an expert whose
// tested claims were all rejected after `minScored` of them is read weekly; a retired or paused expert never; every other
// tracked expert is read daily after those. Ties go by the time of the last poll (never polled first), then by id.
export type PollFacts = {
  id: string;
  status: "candidate" | "tracked" | "paused" | "retired";
  /** Claims whose current status is screened, challenger or promoted (the expert has an L1 or better cluster). */
  screened: number;
  /** Claims whose current status is rejected. */
  rejected: number;
  /** Settled calls that beat the market, and all settled calls. */
  callsPositive: number;
  callsSettled: number;
  /** ISO time of the last poll that read this expert, or null. */
  lastPolledAt: string | null;
};

export type Cadence = "daily-first" | "daily" | "weekly" | "never";

export const WEEKLY_DAYS = 7; // threshold-ok: "weekly" of DAT-230

/** The cadence of one expert. */
export function cadenceOf(f: PollFacts, minScored: number): Cadence {
  if (f.status !== "tracked") return "never"; // candidates are not read until the Owner approves them
  if (f.screened > 0 || (f.callsSettled > 0 && f.callsPositive * 2 > f.callsSettled))
    return "daily-first";
  if (f.screened === 0 && f.rejected >= minScored) return "weekly";
  return "daily";
}

const day = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);

/** True when a weekly expert is due on `today` (YYYY-MM-DD): never polled, or the last poll was a week or more ago. */
const weeklyDue = (f: PollFacts, today: string): boolean =>
  f.lastPolledAt === null || (day(today) - day(f.lastPolledAt)) / 86_400_000 >= WEEKLY_DAYS; // threshold-ok: ms per day

/** The experts to read today, in order. */
export function pollOrder(facts: readonly PollFacts[], today: string, minScored: number): string[] {
  const rank: Record<Cadence, number> = { "daily-first": 0, daily: 1, weekly: 2, never: 9 };
  return facts
    .map((f) => ({ f, c: cadenceOf(f, minScored) }))
    .filter((x) => x.c !== "never" && (x.c !== "weekly" || weeklyDue(x.f, today)))
    .sort((a, b) => {
      if (rank[a.c] !== rank[b.c]) return rank[a.c] - rank[b.c];
      const la = a.f.lastPolledAt ?? "";
      const lb = b.f.lastPolledAt ?? "";
      if (la !== lb) return la < lb ? -1 : 1;
      return a.f.id < b.f.id ? -1 : a.f.id > b.f.id ? 1 : 0;
    })
    .map((x) => x.f.id);
}
