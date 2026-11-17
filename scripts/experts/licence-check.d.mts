export const FORMAT: string;
export const OUT_FILE: string;
export function insideRepo(dir: string): boolean;
export function expertsOf(json: unknown): {
  id: string;
  platforms: string[];
  handles: Record<string, string>;
  homeUrls: string[];
  noFeed: boolean;
}[];
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: {
    out?: (s: string) => void;
    fetch?: (...a: never[]) => Promise<unknown>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    allowInsideRepo?: boolean;
  },
): Promise<number>;
