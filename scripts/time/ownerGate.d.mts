export const CLOCK_OWNER_KEY: string;
export const THIS_RUNTIME: string;
export function ownerFrom(valueJson: unknown): "cloud" | "selfhost";
export function ownerGate(
  env: Record<string, string | undefined>,
  f?: typeof fetch,
): Promise<{ run: boolean; owner: "cloud" | "selfhost" }>;
