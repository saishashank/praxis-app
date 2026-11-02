export declare const RUN_PREFIX: string;
export declare function sweepStaleRunTemps(base?: string): number;
export declare function createRunTemp(base?: string): { dir: string; env: Record<string, string> };
export declare function removeRunTemp(dir: string): void;
export declare function useRunTemp(): () => void;
