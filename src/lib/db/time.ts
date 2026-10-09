// Timestamps are TEXT ISO-8601 UTC with milliseconds and "Z" (D-031, PLT-023).
export function nowIso(): string {
  return new Date().toISOString();
}
