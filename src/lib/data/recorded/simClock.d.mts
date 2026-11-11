export function simNowFromEnv(env: Record<string, string | undefined>): number | null;
export function installSimClock(simNowMs: number, target?: { Date: DateConstructor }): () => void;
